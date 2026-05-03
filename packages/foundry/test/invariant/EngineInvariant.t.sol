// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../../src/MockUSDC.sol";
import {HouseVault} from "../../src/core/HouseVault.sol";
import {LegRegistry} from "../../src/core/LegRegistry.sol";
import {ParlayEngine} from "../../src/core/ParlayEngine.sol";
import {AdminOracleAdapter} from "../../src/oracle/AdminOracleAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LegStatus} from "../../src/interfaces/IOracleAdapter.sol";
import {FeeRouterSetup} from "../helpers/FeeRouterSetup.sol";
import {SignedBuy} from "../helpers/SignedBuy.sol";

/// @title EngineHandler
/// @notice Invariant handler exercising the full signed-quote ticket lifecycle:
///         buy -> resolve legs -> settle / cashoutEarly / claimPayout.
contract EngineHandler is Test {
    MockUSDC public usdc;
    HouseVault public vault;
    ParlayEngine public engine;
    LegRegistry public registry;
    AdminOracleAdapter public oracle;

    address[] public bettors;
    uint256[] public activeTickets;
    uint256 public totalTickets;

    uint256 public constant NUM_LEGS = 6;
    string[NUM_LEGS] public legRefs;
    bool[NUM_LEGS] public legResolved;
    bool[NUM_LEGS] public legExists;

    uint256 public buyCount;
    uint256 public resolveCount;
    uint256 public settleCount;
    uint256 public cashoutCount;
    uint256 public claimPayoutCount;

    uint256 internal _nonce = 1;
    uint256 internal constant SIGNER_PK = 0xA11CE;

    uint256 constant CUTOFF = 600_000;
    uint256 constant RESOLVE = 700_000;
    uint256 constant DEADLINE = 550_000;

    constructor(
        MockUSDC _usdc,
        HouseVault _vault,
        ParlayEngine _engine,
        LegRegistry _registry,
        AdminOracleAdapter _oracle
    ) {
        usdc = _usdc;
        vault = _vault;
        engine = _engine;
        registry = _registry;
        oracle = _oracle;

        legRefs[0] = "leg:eth";
        legRefs[1] = "leg:btc";
        legRefs[2] = "leg:sol";
        legRefs[3] = "leg:doge";
        legRefs[4] = "leg:avax";
        legRefs[5] = "leg:link";

        for (uint256 i = 0; i < 4; i++) {
            address bettor = makeAddr(string(abi.encodePacked("bettor", i)));
            bettors.push(bettor);
            usdc.mint(bettor, 10_000e6);
            vm.prank(bettor);
            usdc.approve(address(engine), type(uint256).max);
        }
    }

    // ── EIP-712 helpers (mirrors ParlayEngine._hashQuote) ────────────────

    function _hashQuoteMemory(ParlayEngine.Quote memory q) internal view returns (bytes32) {
        bytes32 sourceLegTypeHash = keccak256(
            "SourceLeg(string sourceRef,bytes32 outcome,uint256 probabilityPPM,uint256 cutoffTime,uint256 earliestResolve,address oracleAdapter)"
        );
        bytes32 quoteTypeHash = keccak256(
            "Quote(address buyer,uint256 stake,SourceLeg[] legs,uint256 deadline,uint256 nonce)SourceLeg(string sourceRef,bytes32 outcome,uint256 probabilityPPM,uint256 cutoffTime,uint256 earliestResolve,address oracleAdapter)"
        );
        bytes32[] memory legHashes = new bytes32[](q.legs.length);
        for (uint256 i = 0; i < q.legs.length; i++) {
            legHashes[i] = keccak256(
                abi.encode(
                    sourceLegTypeHash,
                    keccak256(bytes(q.legs[i].sourceRef)),
                    q.legs[i].outcome,
                    q.legs[i].probabilityPPM,
                    q.legs[i].cutoffTime,
                    q.legs[i].earliestResolve,
                    q.legs[i].oracleAdapter
                )
            );
        }
        bytes32 structHash = keccak256(
            abi.encode(quoteTypeHash, q.buyer, q.stake, keccak256(abi.encodePacked(legHashes)), q.deadline, q.nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", engine.domainSeparator(), structHash));
    }

    function _signQuote(ParlayEngine.Quote memory q) internal view returns (bytes memory) {
        bytes32 digest = _hashQuoteMemory(q);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _probFor(uint256 idx) internal pure returns (uint256) {
        // Varied but valid (0 < ppm < 1e6) probabilities
        uint256[6] memory probs = [uint256(500_000), 250_000, 200_000, 100_000, 750_000, 333_333];
        return probs[idx];
    }

    /// @notice Buy a signed 2-3 leg ticket.
    function buyTicket(uint256 bettorSeed, uint256 stakeSeed, uint256 legSeed) external {
        address bettor = bettors[bound(bettorSeed, 0, bettors.length - 1)];
        uint256 stake = bound(stakeSeed, 1e6, 20e6);
        if (usdc.balanceOf(bettor) < stake) return;

        uint256 numLegs = bound(legSeed, 2, 3);
        uint256 start = bound(legSeed >> 8, 0, NUM_LEGS - 1);

        // Pick unique legs, preferring unresolved
        uint256[] memory picks = new uint256[](numLegs);
        uint256 picked;
        for (uint256 i = 0; i < NUM_LEGS && picked < numLegs; i++) {
            uint256 idx = (start + i) % NUM_LEGS;
            if (!legResolved[idx]) {
                picks[picked++] = idx;
            }
        }
        for (uint256 i = 0; i < NUM_LEGS && picked < numLegs; i++) {
            uint256 idx = (start + i) % NUM_LEGS;
            bool dup = false;
            for (uint256 j = 0; j < picked; j++) {
                if (picks[j] == idx) {
                    dup = true;
                    break;
                }
            }
            if (!dup) picks[picked++] = idx;
        }
        if (picked < 2) return;

        ParlayEngine.SourceLeg[] memory sourceLegs = new ParlayEngine.SourceLeg[](picked);
        for (uint256 i = 0; i < picked; i++) {
            sourceLegs[i] = ParlayEngine.SourceLeg({
                sourceRef: legRefs[picks[i]],
                outcome: bytes32(uint256(1)),
                probabilityPPM: _probFor(picks[i]),
                cutoffTime: CUTOFF,
                earliestResolve: RESOLVE,
                oracleAdapter: address(oracle)
            });
        }

        uint256 maxPay = vault.maxPayout();
        uint256 freeLiq = vault.freeLiquidity();
        if (maxPay == 0 || freeLiq < 1e6) return;

        ParlayEngine.Quote memory q = ParlayEngine.Quote({
            buyer: bettor,
            stake: stake,
            legs: sourceLegs,
            deadline: DEADLINE,
            nonce: _nonce++
        });
        bytes memory sig = _signQuote(q);

        vm.prank(bettor);
        try engine.buyTicketSigned(q, sig) returns (uint256 ticketId) {
            activeTickets.push(ticketId);
            totalTickets++;
            buyCount++;
            for (uint256 i = 0; i < picked; i++) legExists[picks[i]] = true;
        } catch {
            // expected: vault capacity, etc.
        }
    }

    /// @notice Resolve a random leg (must already be created on-chain).
    function resolveLeg(uint256 legSeed, uint256 statusSeed) external {
        uint256 idx = bound(legSeed, 0, NUM_LEGS - 1);
        if (legResolved[idx] || !legExists[idx]) return;

        // Locate on-chain legId by sourceRef
        (uint256 legId, bool exists) = registry.legIdBySourceRef(legRefs[idx]);
        if (!exists) return;

        uint256 roll = bound(statusSeed, 0, 99);
        LegStatus status;
        if (roll < 60) status = LegStatus.Won;
        else if (roll < 90) status = LegStatus.Lost;
        else status = LegStatus.Voided;

        oracle.resolve(legId, status, keccak256("yes"));
        legResolved[idx] = true;
        resolveCount++;
    }

    function settleTicket(uint256 ticketSeed) external {
        if (activeTickets.length == 0) return;
        uint256 i = bound(ticketSeed, 0, activeTickets.length - 1);
        uint256 ticketId = activeTickets[i];

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        if (t.status != ParlayEngine.TicketStatus.Active) {
            _removeActiveTicket(i);
            return;
        }
        try engine.settleTicket(ticketId) {
            settleCount++;
            _removeActiveTicket(i);
        } catch {}
    }

    function cashoutEarly(uint256 ticketSeed) external {
        if (activeTickets.length == 0) return;
        uint256 i = bound(ticketSeed, 0, activeTickets.length - 1);
        uint256 ticketId = activeTickets[i];

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        if (t.status != ParlayEngine.TicketStatus.Active) {
            _removeActiveTicket(i);
            return;
        }

        address owner_ = engine.ownerOf(ticketId);
        vm.prank(owner_);
        try engine.cashoutEarly(ticketId, 0) {
            cashoutCount++;
            _removeActiveTicket(i);
        } catch {}
    }

    function claimPayout(uint256 ticketSeed) external {
        uint256 totalCount = engine.ticketCount();
        if (totalCount == 0) return;
        uint256 ticketId = bound(ticketSeed, 0, totalCount - 1);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        if (t.status != ParlayEngine.TicketStatus.Won) return;

        address owner_ = engine.ownerOf(ticketId);
        vm.prank(owner_);
        try engine.claimPayout(ticketId) {
            claimPayoutCount++;
        } catch {}
    }

    function depositLiquidity(uint256 amount) external {
        address lp = bettors[0];
        uint256 bal = usdc.balanceOf(lp);
        if (bal < 1e6) return;
        amount = bound(amount, 1e6, bal);
        vm.startPrank(lp);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, lp);
        vm.stopPrank();
    }

    function _removeActiveTicket(uint256 i) internal {
        activeTickets[i] = activeTickets[activeTickets.length - 1];
        activeTickets.pop();
    }

    function activeTicketCount() external view returns (uint256) {
        return activeTickets.length;
    }
}

/// @title EngineInvariantTest
contract EngineInvariantTest is FeeRouterSetup, SignedBuy {
    MockUSDC usdc;
    HouseVault vault;
    LegRegistry registry;
    ParlayEngine engine;
    AdminOracleAdapter oracle;
    EngineHandler handler;

    uint256 constant BOOTSTRAP_ENDS = 1_000_000;

    function setUp() public {
        vm.warp(500_000);

        usdc = new MockUSDC();
        vault = new HouseVault(IERC20(address(usdc)), 8000, 1_000_000, 3);
        registry = new LegRegistry();
        oracle = new AdminOracleAdapter();
        engine = new ParlayEngine(vault, registry, IERC20(address(usdc)), BOOTSTRAP_ENDS, 1000);

        vault.setEngine(address(engine));
        registry.setEngine(address(engine));
        engine.setTrustedQuoteSigner(_signerAddr());

        _wireFeeRouter(vault);

        usdc.approve(address(vault), type(uint256).max);
        for (uint256 i = 0; i < 50; i++) {
            usdc.mint(address(this), 10_000e6);
            vault.deposit(10_000e6, address(this));
        }

        handler = new EngineHandler(usdc, vault, engine, registry, oracle);

        targetContract(address(handler));
    }

    function invariant_reservedNeverExceedsTotalAssets() public view {
        assertLe(vault.totalReserved(), vault.totalAssets(), "CRITICAL: reserved > totalAssets");
    }

    function invariant_engineHoldsZeroUSDC() public view {
        assertEq(usdc.balanceOf(address(engine)), 0, "engine must hold 0 USDC");
    }

    function invariant_freeLiquidityNonNegative() public view {
        assertGe(vault.totalAssets(), vault.totalReserved(), "free liquidity underflow");
    }

    function invariant_callSummary() public view {
        if (handler.buyCount() == 0) return;
        assertTrue(true);
    }
}
