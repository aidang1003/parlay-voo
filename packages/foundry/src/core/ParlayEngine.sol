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

/// @notice Core betting engine: 2-5 leg parlay tickets (ERC721), settled via oracle adapters, paid from HouseVault.
contract ParlayEngine is ERC721, Ownable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

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
        bool isLossless;
    }

    /// @notice One leg of a signed quote. outcome: 0x01 = yes, 0x02 = no (engine applies complement for No).
    struct SourceLeg {
        string sourceRef;
        bytes32 outcome;
        uint256 probabilityPPM;
        uint256 cutoffTime;
        uint256 earliestResolve;
        address oracleAdapter;
    }

    /// @notice EIP-712 payload produced by /api/quote-sign. Bound to buyer + stake; nonce is single-use.
    struct Quote {
        address buyer;
        uint256 stake;
        SourceLeg[] legs;
        uint256 deadline;
        uint256 nonce;
    }

    /// @notice Per-leg snapshot freezing the priced quote at buy time so settle/cashout ignore later registry drift.
    struct LegSnapshot {
        uint256 probabilityPPM;
        address oracleAdapter;
    }

    HouseVault public vault;
    LegRegistry public registry;
    IERC20 public usdc;

    uint256 public bootstrapEndsAt;
    /// @notice Per-leg multiplicative fee BPS, applied as (1 − f) per leg before correlation discount.
    uint256 public protocolFeeBps;
    uint256 public minStake = 1e6;
    uint256 public maxLegs = 5;
    uint256 public cashoutPenaltyBps = 1500;

    uint256 public constant FEE_TO_LOCKERS_BPS = 9000;
    uint256 public constant FEE_TO_SAFETY_BPS = 500;
    // remaining 5% stays in vault implicitly

    uint256 private _nextTicketId;
    mapping(uint256 => Ticket) private _tickets;

    /// @notice Trusted EIP-712 quote signer. Zero address disables buys.
    address public trustedQuoteSigner;

    mapping(uint256 => LegSnapshot[]) private _ticketSnapshots;

    mapping(uint256 => bool) public usedQuoteNonces;

    bytes32 private constant _SOURCE_LEG_TYPEHASH = keccak256(
        "SourceLeg(string sourceRef,bytes32 outcome,uint256 probabilityPPM,uint256 cutoffTime,uint256 earliestResolve,address oracleAdapter)"
    );

    bytes32 private constant _QUOTE_TYPEHASH = keccak256(
        "Quote(address buyer,uint256 stake,SourceLeg[] legs,uint256 deadline,uint256 nonce)SourceLeg(string sourceRef,bytes32 outcome,uint256 probabilityPPM,uint256 cutoffTime,uint256 earliestResolve,address oracleAdapter)"
    );

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
    event ProtocolFeeUpdated(uint256 oldBps, uint256 newBps);
    event MinStakeUpdated(uint256 oldStake, uint256 newStake);
    event MaxLegsUpdated(uint256 oldMaxLegs, uint256 newMaxLegs);
    event TrustedQuoteSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event QuoteConsumed(uint256 indexed nonce, address indexed buyer, uint256 indexed ticketId);
    event LosslessTicketPurchased(
        uint256 indexed ticketId, address indexed buyer, uint256 creditSpent, uint256 potentialPayout
    );
    event LosslessTicketWon(uint256 indexed ticketId, address indexed winner, uint256 payout);

    error MutuallyExclusiveLegs(uint256 legA, uint256 legB);
    error TooManyLegsInGroup(uint256 groupId, uint256 legCount, uint256 cap);
    error FeeTooHigh(uint256 bps);

    constructor(
        HouseVault _vault,
        LegRegistry _registry,
        IERC20 _usdc,
        uint256 _bootstrapEndsAt,
        uint256 _protocolFeeBps
    ) ERC721("ParlayCity Ticket", "PCKT") Ownable(msg.sender) EIP712("ParlayVoo", "1") {
        if (_protocolFeeBps >= 10_000) revert FeeTooHigh(_protocolFeeBps);
        vault = _vault;
        registry = _registry;
        usdc = _usdc;
        bootstrapEndsAt = _bootstrapEndsAt;
        protocolFeeBps = _protocolFeeBps;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setProtocolFeeBps(uint256 _bps) external onlyOwner {
        if (_bps >= 10_000) revert FeeTooHigh(_bps);
        emit ProtocolFeeUpdated(protocolFeeBps, _bps);
        protocolFeeBps = _bps;
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

    /// @notice Set the EIP-712 quote signer. address(0) disables buys.
    function setTrustedQuoteSigner(address _signer) external onlyOwner {
        emit TrustedQuoteSignerUpdated(trustedQuoteSigner, _signer);
        trustedQuoteSigner = _signer;
    }

    function getTicket(uint256 ticketId) external view returns (Ticket memory) {
        require(ticketId < _nextTicketId, "ParlayEngine: invalid ticketId");
        return _tickets[ticketId];
    }

    function ticketCount() external view returns (uint256) {
        return _nextTicketId;
    }

    /// @notice EIP-712 domain separator (for off-chain signers + tests).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice EIP-712 digest a signer produces for a Quote.
    function hashQuote(Quote calldata q) external view returns (bytes32) {
        return _hashQuote(q);
    }

    function getTicketSnapshots(uint256 ticketId) external view returns (LegSnapshot[] memory) {
        require(ticketId < _nextTicketId, "ParlayEngine: invalid ticketId");
        return _ticketSnapshots[ticketId];
    }

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

    /// @dev Caller marks nonce used after validation passes.
    function _verifyQuote(Quote calldata q, bytes calldata signature) internal view {
        require(trustedQuoteSigner != address(0), "ParlayEngine: signer not set");
        require(block.timestamp <= q.deadline, "ParlayEngine: quote expired");
        require(q.buyer == msg.sender, "ParlayEngine: buyer mismatch");
        require(!usedQuoteNonces[q.nonce], "ParlayEngine: nonce used");

        bytes32 digest = _hashQuote(q);
        address recovered = ECDSA.recover(digest, signature);
        require(recovered == trustedQuoteSigner, "ParlayEngine: bad signature");
    }

    /// @notice Purchase a ticket from a backend-signed EIP-712 quote. JIT-creates legs in LegRegistry as needed.
    function buyTicketSigned(Quote calldata quote, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 ticketId)
    {
        _verifyQuote(quote, signature);
        return _buyTicketSigned(quote);
    }

    /// @notice Credit-funded parlay. No USDC, no fee; wins route to PARTIAL lock instead of cash payout.
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

        (uint256[] memory legIdsMem, bytes32[] memory outcomesMem, uint256 fairMulX1e6) = _resolveQuoteLegs(quote);
        _checkExclusion(legIdsMem);
        (uint256 feePaid, uint256 potentialPayout, uint256 multiplierX1e6) =
            _priceQuote(quote.stake, quote.legs.length, fairMulX1e6, _aggregateGroupSizes(legIdsMem));

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

        // freeze per-leg oracle + PPM at buy time; isolates ticket from later registry drift
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

    function _buyLosslessParlay(Quote calldata quote) internal returns (uint256 ticketId) {
        require(quote.legs.length >= 2, "ParlayEngine: need >= 2 legs");
        require(quote.legs.length <= maxLegs, "ParlayEngine: too many legs");
        require(quote.stake >= minStake, "ParlayEngine: stake too low");

        (uint256[] memory legIdsMem, bytes32[] memory outcomesMem, uint256 fairMulX1e6) = _resolveQuoteLegs(quote);
        _checkExclusion(legIdsMem);
        // no fee, but correlation discount applies so reservation respects SGP correlation
        uint256 multiplierX1e6 = _losslessMultiplier(fairMulX1e6, _aggregateGroupSizes(legIdsMem));
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

    /// @dev Returns parallel legIds/outcomes plus the fair multiplier (no fee, no correlation).
    function _resolveQuoteLegs(Quote calldata quote)
        internal
        returns (uint256[] memory legIds, bytes32[] memory outcomes, uint256 fairMulX1e6)
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

        fairMulX1e6 = ParlayMath.computeMultiplier(probsPPM);
    }

    /// @dev Reverts TooManyLegsInGroup when any non-zero group exceeds maxLegsPerGroup.
    function _aggregateGroupSizes(uint256[] memory legIds) internal view returns (uint256[] memory sizes) {
        uint256[] memory corrGroups = registry.getLegCorrGroups(legIds);
        uint256 n = corrGroups.length;
        uint256[] memory tempIds = new uint256[](n);
        uint256[] memory tempSizes = new uint256[](n);
        uint256 unique;

        for (uint256 i = 0; i < n; i++) {
            uint256 g = corrGroups[i];
            if (g == 0) continue;
            bool found;
            for (uint256 j = 0; j < unique; j++) {
                if (tempIds[j] == g) {
                    tempSizes[j]++;
                    found = true;
                    break;
                }
            }
            if (!found) {
                tempIds[unique] = g;
                tempSizes[unique] = 1;
                unique++;
            }
        }

        (,, uint256 cap) = _corrConfig();
        for (uint256 i = 0; i < unique; i++) {
            if (tempSizes[i] > cap) {
                revert TooManyLegsInGroup(tempIds[i], tempSizes[i], cap);
            }
        }

        sizes = new uint256[](unique);
        for (uint256 i = 0; i < unique; i++) {
            sizes[i] = tempSizes[i];
        }
    }

    function _checkExclusion(uint256[] memory legIds) internal view {
        uint256[] memory groups = registry.getLegExclusionGroups(legIds);
        uint256 n = groups.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 g = groups[i];
            if (g == 0) continue;
            for (uint256 j = i + 1; j < n; j++) {
                if (groups[j] == g) revert MutuallyExclusiveLegs(legIds[i], legIds[j]);
            }
        }
    }

    function _corrConfig() internal view returns (uint256 asymptoteBps, uint256 halfSatPpm, uint256 maxLegsPerGroup) {
        (asymptoteBps, halfSatPpm, maxLegsPerGroup) = vault.corrConfig();
    }

    function _losslessMultiplier(uint256 fairMulX1e6, uint256[] memory groupSizes) internal view returns (uint256) {
        (uint256 d, uint256 k,) = _corrConfig();
        return ParlayMath.applyCorrelation(fairMulX1e6, groupSizes, d, k);
    }

    /// @dev Final multiplier folds in (1 − f)^n + correlation; feePaid carves out the 90/5/5 fee portion.
    function _priceQuote(uint256 stake, uint256 legCount, uint256 fairMulX1e6, uint256[] memory groupSizes)
        internal
        view
        returns (uint256 feePaid, uint256 potentialPayout, uint256 multiplierX1e6)
    {
        uint256 fee = protocolFeeBps;
        (uint256 corrAsymptote, uint256 halfSat,) = _corrConfig();
        uint256 feeAdjusted = ParlayMath.applyFee(fairMulX1e6, legCount, fee);
        multiplierX1e6 = ParlayMath.applyCorrelation(feeAdjusted, groupSizes, corrAsymptote, halfSat);
        potentialPayout = ParlayMath.computePayout(stake, multiplierX1e6);

        // iterative loop matches applyFee exactly so effectiveStake = stake × (1−f)^n
        uint256 effectiveStake = ParlayMath.applyFee(stake, legCount, fee);
        feePaid = stake - effectiveStake;
    }

    function _routeFees(uint256 feePaid, uint256 ticketIdForEvent) internal {
        if (feePaid == 0) return;
        uint256 feeToLockers = (feePaid * FEE_TO_LOCKERS_BPS) / 10_000;
        uint256 feeToSafety = (feePaid * FEE_TO_SAFETY_BPS) / 10_000;
        uint256 feeToVault = feePaid - feeToLockers - feeToSafety;
        vault.routeFees(feeToLockers, feeToSafety, feeToVault);
        emit FeesRouted(ticketIdForEvent, feeToLockers, feeToSafety, feeToVault);
    }

    /// @dev Reads from per-ticket snapshot frozen at buy time, not LegRegistry.
    function _legContext(uint256 ticketId, uint256 legIndex)
        internal
        view
        returns (uint256 probabilityPPM, IOracleAdapter oracle)
    {
        LegSnapshot storage s = _ticketSnapshots[ticketId][legIndex];
        return (s.probabilityPPM, IOracleAdapter(s.oracleAdapter));
    }

    /// @notice Permissionless settlement. Checks oracle results for every leg.
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
                // lossless lost: credit already burned at buy, no rehab accrual
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
            uint256 remainingLegs = ticket.legIds.length - voidedCount;
            if (remainingLegs < 2) {
                ticket.status = TicketStatus.Voided;
                if (originalPayout > 0) vault.releasePayout(originalPayout);
                if (ticket.isLossless) {
                    vault.refundCredit(ownerOf(ticketId), ticket.stake);
                } else {
                    uint256 refundAmount = ticket.stake - ticket.feePaid;
                    if (refundAmount > 0) vault.refundVoided(ownerOf(ticketId), refundAmount);
                }
            } else {
                uint256[] memory remainingProbs = new uint256[](remainingLegs);
                uint256 idx = 0;
                for (uint256 i = 0; i < ticket.legIds.length; i++) {
                    (uint256 ppm, IOracleAdapter oracle) = _legContext(ticketId, i);
                    (LegStatus legStatus,) = oracle.getStatus(ticket.legIds[i]);
                    if (legStatus != LegStatus.Voided) {
                        remainingProbs[idx++] =
                            (ticket.outcomes[i] == bytes32(uint256(2))) ? (1_000_000 - ppm) : ppm;
                    }
                }

                uint256 newMultiplier = ParlayMath.computeMultiplier(remainingProbs);
                uint256 effectiveStake = ticket.stake - ticket.feePaid;
                uint256 newPayout = ParlayMath.computePayout(effectiveStake, newMultiplier);

                // cap to originalPayout — that's all the vault reserved
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

    /// @notice Early cashout at fair value minus penalty (penalty scaled by fraction of unresolved legs). Requires no Lost leg + ≥1 Won.
    function cashoutEarly(uint256 ticketId, uint256 minOut) external nonReentrant whenNotPaused {
        require(ticketId < _nextTicketId, "ParlayEngine: invalid ticketId");
        Ticket storage ticket = _tickets[ticketId];
        require(ticket.status == TicketStatus.Active, "ParlayEngine: not active");
        require(ownerOf(ticketId) == msg.sender, "ParlayEngine: not ticket owner");
        require(!ticket.isLossless, "ParlayEngine: no cashout on lossless");

        uint256 wonCount;
        uint256 unresolvedCount;

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

        uint256[] memory wonProbs = new uint256[](wonCount);
        uint256 wIdx;
        for (uint256 i = 0; i < ticket.legIds.length; i++) {
            (uint256 ppm, IOracleAdapter oracle) = _legContext(ticketId, i);

            if (!oracle.canResolve(ticket.legIds[i])) continue;
            (LegStatus legStatus,) = oracle.getStatus(ticket.legIds[i]);
            if (legStatus != LegStatus.Won && legStatus != LegStatus.Lost) continue;

            // losses reverted in first pass, so this must be a won leg
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
