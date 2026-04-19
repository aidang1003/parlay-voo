// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {HouseVault} from "./HouseVault.sol";
import {LegRegistry} from "./LegRegistry.sol";
import {ParlayMath} from "../libraries/ParlayMath.sol";
import {IOracleAdapter, LegStatus} from "../interfaces/IOracleAdapter.sol";

/// @title ParlayEngine
/// @notice Core betting engine for ParlayCity. Users purchase parlay tickets
///         (minted as ERC721 NFTs) by combining 2-5 legs. Tickets are settled
///         via oracle adapters and payouts are disbursed from the HouseVault.
///         Tickets have a single payout flow: hold to settle at full
///         resolution, or exit early via cashoutEarly while no leg has Lost.
contract ParlayEngine is ERC721, Ownable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ── Enums ────────────────────────────────────────────────────────────

    enum SettlementMode {
        FAST,
        OPTIMISTIC
    }
    enum TicketStatus {
        Active,
        Won,
        Lost,
        Voided,
        Claimed
    }

    // ── Structs ──────────────────────────────────────────────────────────

    struct Ticket {
        address buyer;
        uint256 stake;
        uint256[] legIds;
        bytes32[] outcomes;
        uint256 multiplierX1e6;
        uint256 potentialPayout;
        uint256 feePaid;
        SettlementMode mode;
        TicketStatus status;
        uint256 createdAt;
        bool isLossless; // credit-funded; winnings route to PARTIAL lock, losses burn credit only
    }

    // ── Signed-quote types ───────────────────────────────────────────────
    //
    // Polymarket prices live off-chain (CLOB orderbook), so the engine accepts
    // a short-lived EIP-712 Quote signed by a trusted backend signer. The
    // server re-fetches each leg's mid-price, bakes our fee, and signs the
    // resulting probabilities. The engine verifies the signature at buy time
    // and snapshots the attested probabilities + oracle adapter onto the
    // ticket so settlement/cashout never need a live registry read.

    /// @notice One leg of a signed quote.
    /// @param sourceRef Stable identifier of the underlying market
    ///        (e.g. "poly:0xabc..." for Polymarket or "seed:3").
    /// @param outcome Bettor's side. 0x01 = yes, 0x02 = no.
    /// @param probabilityPPM Yes-side implied probability (PPM). The engine
    ///        applies the No-side complement internally when outcome == 0x02.
    /// @param cutoffTime Leg cutoff. Must be > block.timestamp at buy.
    /// @param earliestResolve Oracle earliest-resolve hint; passed through to
    ///        LegRegistry on first create.
    /// @param oracleAdapter Oracle adapter address for this leg. Snapshotted
    ///        onto the ticket so settlement doesn't re-read the registry.
    struct SourceLeg {
        string sourceRef;
        bytes32 outcome;
        uint256 probabilityPPM;
        uint256 cutoffTime;
        uint256 earliestResolve;
        address oracleAdapter;
    }

    /// @notice EIP-712 payload produced by /api/quote-sign.
    /// @param buyer Address allowed to consume this quote. Prevents signed
    ///        quotes from being replayed by other wallets.
    /// @param stake Stake amount the quote was priced for. Binding so a
    ///        backend price is valid only for the exact stake shown to the user.
    /// @param legs Per-leg source data + attested probabilities.
    /// @param deadline Unix timestamp after which the quote is invalid.
    /// @param nonce Per-signer nonce; single-use.
    struct Quote {
        address buyer;
        uint256 stake;
        SourceLeg[] legs;
        uint256 deadline;
        uint256 nonce;
    }

    /// @notice Per-leg data snapshotted onto a ticket at buy time. Parallel
    ///         to Ticket.legIds[]. Freezes the math at the quote priced at
    ///         purchase so settle/cashout cannot be affected by later oracle
    ///         or registry changes.
    struct LegSnapshot {
        uint256 probabilityPPM; // yes-side PPM (same orientation as LegRegistry)
        address oracleAdapter;
    }

    // ── State ────────────────────────────────────────────────────────────

    HouseVault public vault;
    LegRegistry public registry;
    IERC20 public usdc;

    uint256 public bootstrapEndsAt;
    uint256 public baseFee = 100; // bps
    uint256 public perLegFee = 50; // bps
    uint256 public minStake = 1e6; // 1 USDC
    uint256 public maxLegs = 5;
    uint256 public cashoutPenaltyBps = 1500; // 15% base penalty

    /// @notice Fee split constants (BPS of feePaid).
    uint256 public constant FEE_TO_LOCKERS_BPS = 9000; // 90%
    uint256 public constant FEE_TO_SAFETY_BPS = 500; // 5%
    // Remaining 5% stays in vault implicitly

    uint256 private _nextTicketId;
    mapping(uint256 => Ticket) private _tickets;

    /// @notice Trusted off-chain signer for EIP-712 quotes. Owner-settable.
    ///         A zero value disables buys entirely.
    address public trustedQuoteSigner;

    /// @notice Per-ticket leg snapshots, parallel to Ticket.legIds[].
    mapping(uint256 => LegSnapshot[]) private _ticketSnapshots;

    /// @notice One-shot nonces consumed from verified quotes.
    mapping(uint256 => bool) public usedQuoteNonces;

    // ── EIP-712 type hashes ──────────────────────────────────────────────

    bytes32 private constant _SOURCE_LEG_TYPEHASH = keccak256(
        "SourceLeg(string sourceRef,bytes32 outcome,uint256 probabilityPPM,uint256 cutoffTime,uint256 earliestResolve,address oracleAdapter)"
    );

    bytes32 private constant _QUOTE_TYPEHASH = keccak256(
        "Quote(address buyer,uint256 stake,SourceLeg[] legs,uint256 deadline,uint256 nonce)SourceLeg(string sourceRef,bytes32 outcome,uint256 probabilityPPM,uint256 cutoffTime,uint256 earliestResolve,address oracleAdapter)"
    );

    // ── Events ───────────────────────────────────────────────────────────

    event TicketPurchased(
        uint256 indexed ticketId,
        address indexed buyer,
        uint256[] legIds,
        bytes32[] outcomes,
        uint256 stake,
        uint256 multiplierX1e6,
        uint256 potentialPayout,
        SettlementMode mode
    );
    event TicketSettled(uint256 indexed ticketId, TicketStatus status);
    event PayoutClaimed(uint256 indexed ticketId, address indexed winner, uint256 amount);
    event FeesRouted(uint256 indexed ticketId, uint256 feeToLockers, uint256 feeToSafety, uint256 feeToVault);
    event EarlyCashout(uint256 indexed ticketId, address indexed owner, uint256 cashoutValue, uint256 penaltyBps);
    event CashoutPenaltyUpdated(uint256 oldBps, uint256 newBps);
    event BaseFeeUpdated(uint256 oldFee, uint256 newFee);
    event PerLegFeeUpdated(uint256 oldFee, uint256 newFee);
    event MinStakeUpdated(uint256 oldStake, uint256 newStake);
    event MaxLegsUpdated(uint256 oldMaxLegs, uint256 newMaxLegs);
    event TrustedQuoteSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event QuoteConsumed(uint256 indexed nonce, address indexed buyer, uint256 indexed ticketId);
    event LosslessTicketPurchased(
        uint256 indexed ticketId, address indexed buyer, uint256 creditSpent, uint256 potentialPayout
    );
    event LosslessTicketWon(uint256 indexed ticketId, address indexed winner, uint256 payout);

    // ── Constructor ──────────────────────────────────────────────────────

    constructor(HouseVault _vault, LegRegistry _registry, IERC20 _usdc, uint256 _bootstrapEndsAt)
        ERC721("ParlayCity Ticket", "PCKT")
        Ownable(msg.sender)
        EIP712("ParlayVoo", "1")
    {
        vault = _vault;
        registry = _registry;
        usdc = _usdc;
        bootstrapEndsAt = _bootstrapEndsAt;
    }

    // ── Admin ────────────────────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setBaseFee(uint256 _bps) external onlyOwner {
        require(_bps <= 2000, "ParlayEngine: baseFee too high");
        emit BaseFeeUpdated(baseFee, _bps);
        baseFee = _bps;
    }

    function setPerLegFee(uint256 _bps) external onlyOwner {
        require(_bps <= 500, "ParlayEngine: perLegFee too high");
        emit PerLegFeeUpdated(perLegFee, _bps);
        perLegFee = _bps;
    }

    function setMinStake(uint256 _minStake) external onlyOwner {
        require(_minStake >= 1e6, "ParlayEngine: minStake too low");
        emit MinStakeUpdated(minStake, _minStake);
        minStake = _minStake;
    }

    function setMaxLegs(uint256 _maxLegs) external onlyOwner {
        require(_maxLegs >= 2 && _maxLegs <= 10, "ParlayEngine: invalid maxLegs");
        emit MaxLegsUpdated(maxLegs, _maxLegs);
        maxLegs = _maxLegs;
    }

    function setCashoutPenalty(uint256 _bps) external onlyOwner {
        require(_bps <= 5000, "ParlayEngine: penalty too high");
        emit CashoutPenaltyUpdated(cashoutPenaltyBps, _bps);
        cashoutPenaltyBps = _bps;
    }

    /// @notice Set the trusted off-chain signer for EIP-712 quotes. Pass
    ///         address(0) to disable buys.
    function setTrustedQuoteSigner(address _signer) external onlyOwner {
        emit TrustedQuoteSignerUpdated(trustedQuoteSigner, _signer);
        trustedQuoteSigner = _signer;
    }

    // ── Views ────────────────────────────────────────────────────────────

    function getTicket(uint256 ticketId) external view returns (Ticket memory) {
        require(ticketId < _nextTicketId, "ParlayEngine: invalid ticketId");
        return _tickets[ticketId];
    }

    function ticketCount() external view returns (uint256) {
        return _nextTicketId;
    }

    /// @notice EIP-712 domain separator (exposed for off-chain signers + tests).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice EIP-712 digest a signer would produce for a given Quote. Used
    ///         by the off-chain backend and by tests; the engine calls the
    ///         internal version during buy.
    function hashQuote(Quote calldata q) external view returns (bytes32) {
        return _hashQuote(q);
    }

    /// @notice Read per-leg snapshots attached to a signed-quote ticket.
    function getTicketSnapshots(uint256 ticketId) external view returns (LegSnapshot[] memory) {
        require(ticketId < _nextTicketId, "ParlayEngine: invalid ticketId");
        return _ticketSnapshots[ticketId];
    }

    // ── EIP-712 internals ────────────────────────────────────────────────

    /// @dev Hash a single SourceLeg per EIP-712 struct encoding.
    function _hashSourceLeg(SourceLeg calldata leg) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _SOURCE_LEG_TYPEHASH,
                keccak256(bytes(leg.sourceRef)),
                leg.outcome,
                leg.probabilityPPM,
                leg.cutoffTime,
                leg.earliestResolve,
                leg.oracleAdapter
            )
        );
    }

    /// @dev Produce the EIP-712 digest for a Quote.
    function _hashQuote(Quote calldata q) internal view returns (bytes32) {
        bytes32[] memory legHashes = new bytes32[](q.legs.length);
        for (uint256 i = 0; i < q.legs.length; i++) {
            legHashes[i] = _hashSourceLeg(q.legs[i]);
        }
        bytes32 structHash = keccak256(
            abi.encode(
                _QUOTE_TYPEHASH,
                q.buyer,
                q.stake,
                keccak256(abi.encodePacked(legHashes)),
                q.deadline,
                q.nonce
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /// @dev Verify a Quote + signature. Reverts on any failure. Caller is
    ///      responsible for marking the nonce used after side-effect-free
    ///      validation passes.
    function _verifyQuote(Quote calldata q, bytes calldata signature) internal view {
        require(trustedQuoteSigner != address(0), "ParlayEngine: signer not set");
        require(block.timestamp <= q.deadline, "ParlayEngine: quote expired");
        require(q.buyer == msg.sender, "ParlayEngine: buyer mismatch");
        require(!usedQuoteNonces[q.nonce], "ParlayEngine: nonce used");

        bytes32 digest = _hashQuote(q);
        address recovered = ECDSA.recover(digest, signature);
        require(recovered == trustedQuoteSigner, "ParlayEngine: bad signature");
    }

    // ── Core Logic ───────────────────────────────────────────────────────

    /// @notice Purchase a ticket from a backend-signed EIP-712 quote. The
    ///         server re-fetches Polymarket prices, signs a Quote, and the
    ///         engine verifies + consumes the signature here. Any leg whose
    ///         sourceRef isn't yet on-chain is created in LegRegistry as part
    ///         of this tx (just-in-time).
    function buyTicketSigned(Quote calldata quote, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 ticketId)
    {
        _verifyQuote(quote, signature);
        return _buyTicketSigned(quote);
    }

    /// @notice Purchase a parlay funded by rehab credit instead of USDC. The
    ///         stake is deducted from `creditBalance[msg.sender]`; no USDC
    ///         moves and no fee is charged (protocol pays "fair odds on paper"
    ///         — the win is routed into a PARTIAL lock rather than paid in
    ///         cash). Quote flow and leg validation are identical to
    ///         `buyTicketSigned`.
    function buyLosslessParlay(Quote calldata quote, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 ticketId)
    {
        _verifyQuote(quote, signature);
        return _buyLosslessParlay(quote);
    }

    function _buyTicketSigned(Quote calldata quote) internal returns (uint256 ticketId) {
        require(quote.legs.length >= 2, "ParlayEngine: need >= 2 legs");
        require(quote.legs.length <= maxLegs, "ParlayEngine: too many legs");
        require(quote.stake >= minStake, "ParlayEngine: stake too low");

        (uint256[] memory legIdsMem, bytes32[] memory outcomesMem, uint256 multiplierX1e6) = _resolveQuoteLegs(quote);
        (uint256 feePaid, uint256 potentialPayout) = _priceQuote(quote.stake, quote.legs.length, multiplierX1e6);

        require(potentialPayout <= vault.maxPayout(), "ParlayEngine: exceeds vault max payout");
        require(potentialPayout <= vault.freeLiquidity(), "ParlayEngine: insufficient vault liquidity");

        usdc.safeTransferFrom(msg.sender, address(vault), quote.stake);
        vault.reservePayout(potentialPayout);
        _routeFees(feePaid, _nextTicketId);

        ticketId = _nextTicketId++;
        _mint(msg.sender, ticketId);

        SettlementMode mode = block.timestamp < bootstrapEndsAt ? SettlementMode.FAST : SettlementMode.OPTIMISTIC;

        _tickets[ticketId] = Ticket({
            buyer: msg.sender,
            stake: quote.stake,
            legIds: legIdsMem,
            outcomes: outcomesMem,
            multiplierX1e6: multiplierX1e6,
            potentialPayout: potentialPayout,
            feePaid: feePaid,
            mode: mode,
            status: TicketStatus.Active,
            createdAt: block.timestamp,
            isLossless: false
        });

        // Snapshot per-leg oracle + quote PPM so settle/cashout don't re-read
        // LegRegistry. The quote PPM is the one the bettor agreed to; storing
        // it makes the math frozen at buy time and isolates tickets from any
        // subsequent probability drift on the shared registry row.
        LegSnapshot[] storage snaps = _ticketSnapshots[ticketId];
        for (uint256 i = 0; i < quote.legs.length; i++) {
            snaps.push(
                LegSnapshot({probabilityPPM: quote.legs[i].probabilityPPM, oracleAdapter: quote.legs[i].oracleAdapter})
            );
        }

        usedQuoteNonces[quote.nonce] = true;
        emit QuoteConsumed(quote.nonce, msg.sender, ticketId);

        {
            Ticket storage t = _tickets[ticketId];
            emit TicketPurchased(
                ticketId, msg.sender, t.legIds, t.outcomes, quote.stake, multiplierX1e6, potentialPayout, mode
            );
        }
    }

    /// @dev Inner implementation for buyLosslessParlay. Factored out of the
    ///      external entry to keep stack depth under limit.
    function _buyLosslessParlay(Quote calldata quote) internal returns (uint256 ticketId) {
        require(quote.legs.length >= 2, "ParlayEngine: need >= 2 legs");
        require(quote.legs.length <= maxLegs, "ParlayEngine: too many legs");
        require(quote.stake >= minStake, "ParlayEngine: stake too low");

        (uint256[] memory legIdsMem, bytes32[] memory outcomesMem, uint256 multiplierX1e6) = _resolveQuoteLegs(quote);
        // Lossless: no fee deduction, full stake used as effective stake.
        uint256 potentialPayout = ParlayMath.computePayout(quote.stake, multiplierX1e6);

        require(potentialPayout <= vault.maxPayout(), "ParlayEngine: exceeds vault max payout");
        require(potentialPayout <= vault.freeLiquidity(), "ParlayEngine: insufficient vault liquidity");

        vault.spendCredit(msg.sender, quote.stake);
        vault.reservePayout(potentialPayout);

        ticketId = _nextTicketId++;
        _mint(msg.sender, ticketId);

        SettlementMode mode = block.timestamp < bootstrapEndsAt ? SettlementMode.FAST : SettlementMode.OPTIMISTIC;

        _tickets[ticketId] = Ticket({
            buyer: msg.sender,
            stake: quote.stake,
            legIds: legIdsMem,
            outcomes: outcomesMem,
            multiplierX1e6: multiplierX1e6,
            potentialPayout: potentialPayout,
            feePaid: 0,
            mode: mode,
            status: TicketStatus.Active,
            createdAt: block.timestamp,
            isLossless: true
        });

        LegSnapshot[] storage snaps = _ticketSnapshots[ticketId];
        for (uint256 i = 0; i < quote.legs.length; i++) {
            snaps.push(
                LegSnapshot({probabilityPPM: quote.legs[i].probabilityPPM, oracleAdapter: quote.legs[i].oracleAdapter})
            );
        }

        usedQuoteNonces[quote.nonce] = true;
        emit QuoteConsumed(quote.nonce, msg.sender, ticketId);

        {
            Ticket storage t = _tickets[ticketId];
            emit TicketPurchased(
                ticketId, msg.sender, t.legIds, t.outcomes, quote.stake, multiplierX1e6, potentialPayout, mode
            );
            emit LosslessTicketPurchased(ticketId, msg.sender, quote.stake, potentialPayout);
        }
    }

    /// @dev Resolve-or-create every leg referenced by a quote and return the
    ///      parallel legIds / outcomes arrays plus the computed multiplier.
    ///      Factored out of _buyTicketSigned to keep that function under the
    ///      stack-slot budget.
    function _resolveQuoteLegs(Quote calldata quote)
        internal
        returns (uint256[] memory legIds, bytes32[] memory outcomes, uint256 multiplierX1e6)
    {
        uint256 n = quote.legs.length;
        legIds = new uint256[](n);
        outcomes = new bytes32[](n);
        uint256[] memory probsPPM = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            SourceLeg calldata sl = quote.legs[i];
            require(block.timestamp < sl.cutoffTime, "ParlayEngine: cutoff passed");
            require(sl.probabilityPPM > 0 && sl.probabilityPPM < 1_000_000, "ParlayEngine: bad probability");

            uint256 legId = registry.getOrCreateBySourceRef(
                sl.sourceRef, sl.sourceRef, sl.cutoffTime, sl.earliestResolve, sl.oracleAdapter, sl.probabilityPPM
            );

            for (uint256 j = 0; j < i; j++) {
                require(legIds[j] != legId, "ParlayEngine: duplicate leg");
            }
            legIds[i] = legId;
            outcomes[i] = sl.outcome;

            probsPPM[i] = (sl.outcome == bytes32(uint256(2))) ? (1_000_000 - sl.probabilityPPM) : sl.probabilityPPM;
        }

        multiplierX1e6 = ParlayMath.computeMultiplier(probsPPM);
    }

    /// @dev Compute fee + potentialPayout from a stake + leg count + multiplier.
    function _priceQuote(uint256 stake, uint256 legCount, uint256 multiplierX1e6)
        internal
        view
        returns (uint256 feePaid, uint256 potentialPayout)
    {
        uint256 totalEdgeBps = ParlayMath.computeEdge(legCount, baseFee, perLegFee);
        feePaid = (stake * totalEdgeBps) / 10_000;
        potentialPayout = ParlayMath.computePayout(stake - feePaid, multiplierX1e6);
    }

    /// @dev Apply the 90/5/5 fee split. No-op when feePaid == 0.
    function _routeFees(uint256 feePaid, uint256 ticketIdForEvent) internal {
        if (feePaid == 0) return;
        uint256 feeToLockers = (feePaid * FEE_TO_LOCKERS_BPS) / 10_000;
        uint256 feeToSafety = (feePaid * FEE_TO_SAFETY_BPS) / 10_000;
        uint256 feeToVault = feePaid - feeToLockers - feeToSafety;
        vault.routeFees(feeToLockers, feeToSafety, feeToVault);
        emit FeesRouted(ticketIdForEvent, feeToLockers, feeToSafety, feeToVault);
    }

    /// @dev Resolve the (probabilityPPM, oracleAdapter) pair for a ticket's
    ///      leg at settlement/cashout time. Read from the per-ticket snapshot
    ///      written at buy time — the math is frozen against the backend-
    ///      attested price, isolated from any subsequent registry drift.
    function _legContext(uint256 ticketId, uint256 legIndex)
        internal
        view
        returns (uint256 probabilityPPM, IOracleAdapter oracle)
    {
        LegSnapshot storage s = _ticketSnapshots[ticketId][legIndex];
        return (s.probabilityPPM, IOracleAdapter(s.oracleAdapter));
    }

    /// @notice Settle a ticket by checking oracle results for every leg.
    ///         Anyone can call this (permissionless settlement).
    function settleTicket(uint256 ticketId) external nonReentrant whenNotPaused {
        require(ticketId < _nextTicketId, "ParlayEngine: invalid ticketId");
        Ticket storage ticket = _tickets[ticketId];
        require(ticket.status == TicketStatus.Active, "ParlayEngine: not active");

        bool allWon = true;
        bool anyLost = false;
        uint256 voidedCount = 0;

        for (uint256 i = 0; i < ticket.legIds.length; i++) {
            (, IOracleAdapter oracle) = _legContext(ticketId, i);
            require(oracle.canResolve(ticket.legIds[i]), "ParlayEngine: leg not resolvable");

            (LegStatus legStatus,) = oracle.getStatus(ticket.legIds[i]);

            // Determine if the bettor's chosen side won:
            // Yes bet (outcome != 0x02): wins when leg status is Won
            // No bet  (outcome == 0x02): wins when leg status is Lost
            bool isNoBet = ticket.outcomes[i] == bytes32(uint256(2));
            bool bettorWon;

            if (legStatus == LegStatus.Voided) {
                voidedCount++;
                allWon = false;
                continue;
            } else if (legStatus == LegStatus.Won) {
                bettorWon = !isNoBet;
            } else if (legStatus == LegStatus.Lost) {
                bettorWon = isNoBet;
            } else {
                revert("ParlayEngine: unexpected leg status");
            }

            if (!bettorWon) {
                anyLost = true;
                allWon = false;
                break;
            }
        }

        uint256 originalPayout = ticket.potentialPayout;

        if (anyLost) {
            ticket.status = TicketStatus.Lost;
            if (originalPayout > 0) vault.releasePayout(originalPayout);
            if (!ticket.isLossless) {
                // Rehab carve applies to USDC-funded tickets only. Lossless
                // tickets already consumed credit at buy; a loss simply burns
                // the credit with no new claimable accrual.
                uint256 effectiveStake = ticket.stake - ticket.feePaid;
                if (effectiveStake > 0) {
                    vault.distributeLoss(effectiveStake, ownerOf(ticketId));
                }
            }
        } else if (allWon) {
            if (ticket.isLossless) {
                vault.routeLosslessWin(ownerOf(ticketId), originalPayout);
                ticket.status = TicketStatus.Claimed;
                emit LosslessTicketWon(ticketId, ownerOf(ticketId), originalPayout);
            } else {
                ticket.status = TicketStatus.Won;
            }
        } else {
            // Some legs voided, rest won. Recalculate with remaining legs.
            uint256 remainingLegs = ticket.legIds.length - voidedCount;
            if (remainingLegs < 2) {
                // Not enough legs for a valid parlay: void the ticket and
                // refund the effective stake.
                ticket.status = TicketStatus.Voided;
                if (originalPayout > 0) vault.releasePayout(originalPayout);
                if (ticket.isLossless) {
                    // Refund credit (stake was credit, not USDC).
                    vault.refundCredit(ownerOf(ticketId), ticket.stake);
                } else {
                    uint256 refundAmount = ticket.stake - ticket.feePaid;
                    if (refundAmount > 0) vault.refundVoided(ownerOf(ticketId), refundAmount);
                }
            } else {
                // Recalculate multiplier with only the non-voided legs.
                uint256[] memory remainingProbs = new uint256[](remainingLegs);
                uint256 idx = 0;
                for (uint256 i = 0; i < ticket.legIds.length; i++) {
                    (uint256 ppm, IOracleAdapter oracle) = _legContext(ticketId, i);
                    (LegStatus legStatus,) = oracle.getStatus(ticket.legIds[i]);
                    if (legStatus != LegStatus.Voided) {
                        // Use complement for No bets, same as at buy time.
                        remainingProbs[idx++] =
                            (ticket.outcomes[i] == bytes32(uint256(2))) ? (1_000_000 - ppm) : ppm;
                    }
                }

                uint256 newMultiplier = ParlayMath.computeMultiplier(remainingProbs);
                uint256 effectiveStake = ticket.stake - ticket.feePaid;
                uint256 newPayout = ParlayMath.computePayout(effectiveStake, newMultiplier);

                // Cap newPayout at originalPayout (vault only reserved that much).
                if (newPayout > originalPayout) newPayout = originalPayout;
                if (originalPayout > newPayout) vault.releasePayout(originalPayout - newPayout);

                ticket.potentialPayout = newPayout;
                ticket.multiplierX1e6 = newMultiplier;
                if (ticket.isLossless) {
                    vault.routeLosslessWin(ownerOf(ticketId), newPayout);
                    ticket.status = TicketStatus.Claimed;
                    emit LosslessTicketWon(ticketId, ownerOf(ticketId), newPayout);
                } else {
                    ticket.status = TicketStatus.Won;
                }
            }
        }

        emit TicketSettled(ticketId, ticket.status);
    }

    /// @notice Claim the payout for a winning ticket.
    function claimPayout(uint256 ticketId) external nonReentrant whenNotPaused {
        require(ticketId < _nextTicketId, "ParlayEngine: invalid ticketId");
        Ticket storage ticket = _tickets[ticketId];
        require(ticket.status == TicketStatus.Won, "ParlayEngine: not won");
        require(ownerOf(ticketId) == msg.sender, "ParlayEngine: not ticket owner");

        uint256 amount = ticket.potentialPayout;
        require(amount > 0, "ParlayEngine: nothing to claim");

        ticket.status = TicketStatus.Claimed;
        vault.payWinner(msg.sender, amount);
        emit PayoutClaimed(ticketId, msg.sender, amount);
    }

    /// @notice Cash out an Active ticket at fair value minus the cashout
    ///         penalty. Callable on any ticket where no leg has Lost and at
    ///         least one leg has Won — pays out based on won legs' implied
    ///         multiplier, penalty scaled by the fraction of unresolved legs.
    ///         Closes the ticket and releases the remaining reserve.
    /// @param ticketId The ticket to cash out.
    /// @param minOut Minimum cashout value (slippage protection).
    function cashoutEarly(uint256 ticketId, uint256 minOut) external nonReentrant whenNotPaused {
        require(ticketId < _nextTicketId, "ParlayEngine: invalid ticketId");
        Ticket storage ticket = _tickets[ticketId];
        require(ticket.status == TicketStatus.Active, "ParlayEngine: not active");
        require(ownerOf(ticketId) == msg.sender, "ParlayEngine: not ticket owner");
        require(!ticket.isLossless, "ParlayEngine: no cashout on lossless");

        uint256 wonCount;
        uint256 unresolvedCount;

        // First pass: categorize legs and check for losses.
        for (uint256 i = 0; i < ticket.legIds.length; i++) {
            (, IOracleAdapter oracle) = _legContext(ticketId, i);

            if (!oracle.canResolve(ticket.legIds[i])) {
                unresolvedCount++;
                continue;
            }

            (LegStatus legStatus,) = oracle.getStatus(ticket.legIds[i]);

            if (legStatus == LegStatus.Voided) {
                unresolvedCount++;
                continue;
            }

            bool isNoBet = ticket.outcomes[i] == bytes32(uint256(2));
            bool bettorWon;
            if (legStatus == LegStatus.Won) {
                bettorWon = !isNoBet;
            } else if (legStatus == LegStatus.Lost) {
                bettorWon = isNoBet;
            } else {
                unresolvedCount++;
                continue;
            }

            require(bettorWon, "ParlayEngine: leg already lost");
            wonCount++;
        }

        require(wonCount > 0, "ParlayEngine: need at least 1 won leg");
        require(unresolvedCount > 0, "ParlayEngine: all resolved, use settleTicket");

        // Second pass: collect won probabilities.
        uint256[] memory wonProbs = new uint256[](wonCount);
        uint256 wIdx;
        for (uint256 i = 0; i < ticket.legIds.length; i++) {
            (uint256 ppm, IOracleAdapter oracle) = _legContext(ticketId, i);

            if (!oracle.canResolve(ticket.legIds[i])) continue;
            (LegStatus legStatus,) = oracle.getStatus(ticket.legIds[i]);
            if (legStatus != LegStatus.Won && legStatus != LegStatus.Lost) continue;

            // Must be a won leg (losses already reverted in first pass).
            wonProbs[wIdx++] = (ticket.outcomes[i] == bytes32(uint256(2))) ? (1_000_000 - ppm) : ppm;
        }

        uint256 effectiveStake = ticket.stake - ticket.feePaid;
        (uint256 cashoutValue, uint256 penaltyBps) = ParlayMath.computeCashoutValue(
            effectiveStake,
            wonProbs,
            unresolvedCount,
            cashoutPenaltyBps,
            ticket.legIds.length,
            ticket.potentialPayout
        );

        require(cashoutValue > 0, "ParlayEngine: zero cashout value");
        require(cashoutValue >= minOut, "ParlayEngine: below min cashout");

        ticket.status = TicketStatus.Claimed;
        vault.payWinner(msg.sender, cashoutValue);
        if (ticket.potentialPayout > cashoutValue) {
            vault.releasePayout(ticket.potentialPayout - cashoutValue);
        }

        emit EarlyCashout(ticketId, msg.sender, cashoutValue, penaltyBps);
    }
}
