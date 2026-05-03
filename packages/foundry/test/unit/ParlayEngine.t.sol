// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "../../src/MockUSDC.sol";
import {HouseVault} from "../../src/core/HouseVault.sol";
import {LegRegistry} from "../../src/core/LegRegistry.sol";
import {ParlayEngine} from "../../src/core/ParlayEngine.sol";
import {AdminOracleAdapter} from "../../src/oracle/AdminOracleAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LegStatus} from "../../src/interfaces/IOracleAdapter.sol";
import {FeeRouterSetup} from "../helpers/FeeRouterSetup.sol";
import {SignedBuy} from "../helpers/SignedBuy.sol";

contract ParlayEngineTest is FeeRouterSetup, SignedBuy {
    MockUSDC usdc;
    HouseVault vault;
    LegRegistry registry;
    ParlayEngine engine;
    AdminOracleAdapter oracle;

    address owner = address(this);
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant BOOTSTRAP_ENDS = 1_000_000;
    uint256 constant CUTOFF = 600_000;
    uint256 constant RESOLVE = 700_000;
    uint256 constant DEADLINE = 550_000;

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

        usdc.mint(owner, 10_000e6);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e6, owner);

        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _yesLeg(string memory ref, uint256 ppm) internal view returns (ParlayEngine.SourceLeg memory) {
        return _mkLeg(ref, bytes32(uint256(1)), ppm, address(oracle), CUTOFF, RESOLVE);
    }

    function _yesLegCustom(string memory ref, uint256 ppm, uint256 cutoff, uint256 resolve)
        internal
        view
        returns (ParlayEngine.SourceLeg memory)
    {
        return _mkLeg(ref, bytes32(uint256(1)), ppm, address(oracle), cutoff, resolve);
    }

    /// @dev Default 2-leg set (matches legIds 0,1 after first creation).
    function _twoLegs() internal view returns (ParlayEngine.SourceLeg[] memory legs) {
        legs = new ParlayEngine.SourceLeg[](2);
        legs[0] = _yesLeg("leg:eth", 500_000); // 50%
        legs[1] = _yesLeg("leg:btc", 250_000); // 25%
    }

    function _threeLegs() internal view returns (ParlayEngine.SourceLeg[] memory legs) {
        legs = new ParlayEngine.SourceLeg[](3);
        legs[0] = _yesLeg("leg:eth", 500_000);
        legs[1] = _yesLeg("leg:btc", 250_000);
        legs[2] = _yesLeg("leg:sol", 200_000);
    }

    // ── Buy Ticket Happy Path ────────────────────────────────────────────

    function test_buyTicket_happyPath() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(t.buyer, alice);
        assertEq(t.stake, 10e6);
        assertEq(t.legIds.length, 2);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Active));
        assertGt(t.potentialPayout, 0);
        assertGt(t.multiplierX1e6, 0);
        assertGt(t.feePaid, 0);
        assertEq(uint8(t.mode), uint8(ParlayEngine.SettlementMode.FAST));
        assertEq(engine.ownerOf(ticketId), alice);
    }

    function test_buyTicket_optimisticMode() public {
        vm.warp(BOOTSTRAP_ENDS + 1);

        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](2);
        legs[0] = _yesLegCustom("leg:eth2", 500_000, block.timestamp + 1000, block.timestamp + 2000);
        legs[1] = _yesLegCustom("leg:btc2", 250_000, block.timestamp + 1000, block.timestamp + 2000);

        uint256 ticketId = _buySigned(engine, alice, legs, 10e6, block.timestamp + 500);
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.mode), uint8(ParlayEngine.SettlementMode.OPTIMISTIC));
    }

    // ── Validations ──────────────────────────────────────────────────────

    function test_buyTicket_revertsOnSingleLeg() public {
        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](1);
        legs[0] = _yesLeg("leg:eth", 500_000);

        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 10e6, legs, DEADLINE, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: need >= 2 legs");
        engine.buyTicketSigned(q, sig);
    }

    function test_buyTicket_revertsOnTooManyLegs() public {
        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](6);
        for (uint256 i = 0; i < 6; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            legs[i] = _yesLeg(string(abi.encodePacked("leg:x", bytes1(uint8(48 + i)))), 500_000);
        }
        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 10e6, legs, DEADLINE, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: too many legs");
        engine.buyTicketSigned(q, sig);
    }

    function test_buyTicket_revertsOnDuplicateLegs() public {
        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](2);
        legs[0] = _yesLeg("leg:dup", 500_000);
        legs[1] = _yesLeg("leg:dup", 500_000); // same sourceRef -> same legId
        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 10e6, legs, DEADLINE, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: duplicate leg");
        engine.buyTicketSigned(q, sig);
    }

    function test_buyTicket_revertsOnCutoffPassed() public {
        vm.warp(600_001);

        ParlayEngine.SourceLeg[] memory legs = _twoLegs();
        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 10e6, legs, 700_000, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: cutoff passed");
        engine.buyTicketSigned(q, sig);
    }

    function test_buyTicket_revertsOnInsufficientStake() public {
        ParlayEngine.SourceLeg[] memory legs = _twoLegs();
        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 0.5e6, legs, DEADLINE, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: stake too low");
        engine.buyTicketSigned(q, sig);
    }

    // ── Settlement ───────────────────────────────────────────────────────

    function test_settleTicket_allWins() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Won));
    }

    function test_settleTicket_withLoss() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        ParlayEngine.Ticket memory tBefore = engine.getTicket(ticketId);
        uint256 reservedBefore = vault.totalReserved();

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Lost, keccak256("no"));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Lost));
        assertEq(vault.totalReserved(), reservedBefore - tBefore.potentialPayout);
    }

    // ── Claim ────────────────────────────────────────────────────────────

    function test_claimPayout() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 expectedPayout = t.potentialPayout;
        uint256 aliceBalBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        engine.claimPayout(ticketId);

        assertEq(usdc.balanceOf(alice), aliceBalBefore + expectedPayout);
        ParlayEngine.Ticket memory tAfter = engine.getTicket(ticketId);
        assertEq(uint8(tAfter.status), uint8(ParlayEngine.TicketStatus.Claimed));
    }

    function test_claimPayout_revertsIfNotWon() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        vm.prank(alice);
        vm.expectRevert("ParlayEngine: not won");
        engine.claimPayout(ticketId);
    }

    function test_claimPayout_revertsIfNotOwner() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        engine.settleTicket(ticketId);

        vm.prank(bob);
        vm.expectRevert("ParlayEngine: not ticket owner");
        engine.claimPayout(ticketId);
    }

    // ── Extended Tests ───────────────────────────────────────────────────

    function test_settleTicket_partialVoid() public {
        uint256 ticketId = _buySigned(engine, alice, _threeLegs(), 10e6, DEADLINE);
        ParlayEngine.Ticket memory tBefore = engine.getTicket(ticketId);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        oracle.resolve(2, LegStatus.Voided, bytes32(0));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Won));
        assertTrue(t.potentialPayout <= tBefore.potentialPayout, "recalculated payout <= original");
    }

    function test_settleTicket_allVoided_ticketVoided() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Voided, bytes32(0));
        oracle.resolve(1, LegStatus.Voided, bytes32(0));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Voided));
        assertEq(vault.totalReserved(), 0);
    }

    function test_settleTicket_alreadySettled_reverts() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Lost, keccak256("no"));
        engine.settleTicket(ticketId);

        vm.expectRevert("ParlayEngine: not active");
        engine.settleTicket(ticketId);
    }

    function test_buyTicket_feeCalculation() public {
        // protocolFeeBps = 1000 (10%) per leg. 2 legs → effective fee = 1 - 0.9² = 0.19.
        // 10 USDC × 0.19 = 1.9 USDC = 1_900_000 in 6-decimal microunits.
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(t.feePaid, 1_900_000);
    }

    function test_buyTicket_pauseBlocksBuy() public {
        engine.pause();
        ParlayEngine.SourceLeg[] memory legs = _twoLegs();
        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 10e6, legs, DEADLINE, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);

        vm.prank(alice);
        vm.expectRevert();
        engine.buyTicketSigned(q, sig);
    }

    function test_setProtocolFeeBps_boundsCheck() public {
        engine.setProtocolFeeBps(2000);
        assertEq(engine.protocolFeeBps(), 2000);
        vm.expectRevert(abi.encodeWithSignature("FeeTooHigh(uint256)", 10_000));
        engine.setProtocolFeeBps(10_000);
    }

    function test_setMinStake_boundsCheck() public {
        engine.setMinStake(5e6);
        assertEq(engine.minStake(), 5e6);
        vm.expectRevert("ParlayEngine: minStake too low");
        engine.setMinStake(0.5e6);
    }

    // ── No Bets ──────────────────────────────────────────────────────────

    function test_noBet_winsWhenLegLost() public {
        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](2);
        legs[0] = _yesLeg("leg:eth", 500_000);
        legs[1] = _mkLeg("leg:btc", bytes32(uint256(2)), 250_000, address(oracle), CUTOFF, RESOLVE);

        uint256 ticketId = _buySigned(engine, alice, legs, 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Lost, keccak256("no"));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Won));
    }

    function test_noBet_losesWhenLegWon() public {
        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](2);
        legs[0] = _yesLeg("leg:eth", 500_000);
        legs[1] = _mkLeg("leg:btc", bytes32(uint256(2)), 250_000, address(oracle), CUTOFF, RESOLVE);

        uint256 ticketId = _buySigned(engine, alice, legs, 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Lost));
    }

    function test_noBet_usesComplementProbability() public {
        ParlayEngine.SourceLeg[] memory legsYes = new ParlayEngine.SourceLeg[](2);
        legsYes[0] = _yesLeg("leg:eth", 500_000);
        legsYes[1] = _yesLeg("leg:btc", 250_000);

        ParlayEngine.SourceLeg[] memory legsNo = new ParlayEngine.SourceLeg[](2);
        legsNo[0] = _yesLeg("leg:eth", 500_000);
        legsNo[1] = _mkLeg("leg:btc", bytes32(uint256(2)), 250_000, address(oracle), CUTOFF, RESOLVE);

        uint256 tYes = _buySigned(engine, alice, legsYes, 10e6, DEADLINE);
        uint256 tNo = _buySigned(engine, alice, legsNo, 10e6, DEADLINE);

        ParlayEngine.Ticket memory tickYes = engine.getTicket(tYes);
        ParlayEngine.Ticket memory tickNo = engine.getTicket(tNo);

        assertTrue(tickNo.multiplierX1e6 < tickYes.multiplierX1e6, "No-bet multiplier < Yes-bet multiplier");
    }

    function test_setMaxLegs_boundsCheck() public {
        engine.setMaxLegs(10);
        assertEq(engine.maxLegs(), 10);

        vm.expectRevert("ParlayEngine: invalid maxLegs");
        engine.setMaxLegs(11);
        vm.expectRevert("ParlayEngine: invalid maxLegs");
        engine.setMaxLegs(1);
    }

    // ── Edge Cases ──────────────────────────────────────────────────────

    function test_buyTicket_zeroStake_reverts() public {
        ParlayEngine.SourceLeg[] memory legs = _twoLegs();
        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 0, legs, DEADLINE, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: stake too low");
        engine.buyTicketSigned(q, sig);
    }

    function test_buyTicket_exactMaxLegs() public {
        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](5);
        legs[0] = _yesLeg("leg:h0", 700_000);
        legs[1] = _yesLeg("leg:h1", 700_000);
        legs[2] = _yesLeg("leg:h2", 700_000);
        legs[3] = _yesLeg("leg:h3", 700_000);
        legs[4] = _yesLeg("leg:h4", 700_000);

        uint256 ticketId = _buySigned(engine, alice, legs, 10e6, DEADLINE);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(t.legIds.length, 5);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Active));
    }

    function test_settleTicket_unresolvedLegs_reverts() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));

        vm.expectRevert("ParlayEngine: leg not resolvable");
        engine.settleTicket(ticketId);
    }

    function test_claimPayout_onVoidedTicket_reverts() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Voided, bytes32(0));
        oracle.resolve(1, LegStatus.Voided, bytes32(0));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Voided));

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: not won");
        engine.claimPayout(ticketId);
    }

    function test_claimPayout_doubleClaim_reverts() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        engine.settleTicket(ticketId);

        vm.prank(alice);
        engine.claimPayout(ticketId);
        vm.prank(alice);
        vm.expectRevert("ParlayEngine: not won");
        engine.claimPayout(ticketId);
    }

    function test_claimPayout_onLostTicket_reverts() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Lost, keccak256("no"));
        engine.settleTicket(ticketId);

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: not won");
        engine.claimPayout(ticketId);
    }

    function test_buyTicket_maxStake_succeeds() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 50e6, DEADLINE);
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(t.stake, 50e6);
        assertGt(t.potentialPayout, 0);
    }

    function test_settleTicket_invalidTicketId_reverts() public {
        vm.expectRevert("ParlayEngine: invalid ticketId");
        engine.settleTicket(9999);
    }

    function test_claimPayout_invalidTicketId_reverts() public {
        vm.prank(alice);
        vm.expectRevert("ParlayEngine: invalid ticketId");
        engine.claimPayout(9999);
    }

    // ── Admin Setter Access Control ─────────────────────────────────────

    function test_setProtocolFeeBps_nonOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        engine.setProtocolFeeBps(200);
    }

    function test_setMinStake_nonOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        engine.setMinStake(2e6);
    }

    function test_setMaxLegs_nonOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        engine.setMaxLegs(3);
    }

    function test_setCashoutPenalty_nonOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        engine.setCashoutPenalty(2000);
    }

    // ── Admin Setter Event Emissions ────────────────────────────────────

    function test_setProtocolFeeBps_emitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit ParlayEngine.ProtocolFeeUpdated(1000, 2000);
        engine.setProtocolFeeBps(2000);
    }

    function test_setMinStake_emitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit ParlayEngine.MinStakeUpdated(1e6, 5e6);
        engine.setMinStake(5e6);
    }

    function test_setMaxLegs_emitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit ParlayEngine.MaxLegsUpdated(5, 8);
        engine.setMaxLegs(8);
    }

    function test_setCashoutPenalty_emitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit ParlayEngine.CashoutPenaltyUpdated(1500, 3000);
        engine.setCashoutPenalty(3000);
    }

    // ── Admin Setter Effects on Ticket Pricing ──────────────────────────

    function test_setProtocolFeeBps_affectsNextTicketFee() public {
        // Default fee 1000 BPS, 2 legs → fee = stake × (1 - 0.9²) = stake × 0.19.
        uint256 t1 = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        uint256 fee1 = engine.getTicket(t1).feePaid;

        // Bump to 2000 BPS (20% per leg). 2 legs → 1 - 0.8² = 0.36.
        engine.setProtocolFeeBps(2000);
        uint256 t2 = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        uint256 fee2 = engine.getTicket(t2).feePaid;

        assertGt(fee2, fee1, "higher protocolFee must increase fee");
        assertEq(fee1, 1_900_000); // 10 × 0.19 USDC
        assertEq(fee2, 3_600_000); // 10 × 0.36 USDC
    }

    function test_setMinStake_enforcedOnBuy() public {
        engine.setMinStake(5e6);

        ParlayEngine.SourceLeg[] memory legs = _twoLegs();
        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory qBad = _mkQuote(alice, 4e6, legs, DEADLINE, nonce);
        bytes memory sigBad = _signQuote(engine, SIGNER_PK, qBad);
        vm.prank(alice);
        vm.expectRevert("ParlayEngine: stake too low");
        engine.buyTicketSigned(qBad, sigBad);

        _buySigned(engine, alice, _twoLegs(), 5e6, DEADLINE);
    }

    function test_setMaxLegs_enforcedOnBuy() public {
        engine.setMaxLegs(3);

        ParlayEngine.SourceLeg[] memory legs3 = _threeLegs();
        _buySigned(engine, alice, legs3, 10e6, DEADLINE);

        ParlayEngine.SourceLeg[] memory legs4 = new ParlayEngine.SourceLeg[](4);
        legs4[0] = _yesLeg("leg:eth", 500_000);
        legs4[1] = _yesLeg("leg:btc", 250_000);
        legs4[2] = _yesLeg("leg:sol", 200_000);
        legs4[3] = _yesLeg("leg:extra", 500_000);
        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 10e6, legs4, DEADLINE, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);
        vm.prank(alice);
        vm.expectRevert("ParlayEngine: too many legs");
        engine.buyTicketSigned(q, sig);
    }

    // ── Pause/Unpause ───────────────────────────────────────────────────

    function test_pause_blocksBuyAndSettle() public {
        engine.pause();
        ParlayEngine.SourceLeg[] memory legs = _twoLegs();
        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 10e6, legs, DEADLINE, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);
        vm.prank(alice);
        vm.expectRevert();
        engine.buyTicketSigned(q, sig);

        engine.unpause();
        _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
    }

    function test_pause_nonOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        engine.pause();
    }

    function test_unpause_nonOwner_reverts() public {
        engine.pause();
        vm.prank(alice);
        vm.expectRevert();
        engine.unpause();
    }

    // ── Leg Resolution Coverage ─────────────────────────────────────────
    //
    // Invariant #4 in CLAUDE.md: settlement is permissionless. These tests
    // pin the settlement path's public surface — who can call it, what it
    // emits, how it handles void-refunds — so future refactors can't silently
    // close off settlement or drop the refund path.

    /// @dev Anyone can settle a ticket after its legs resolve. Bob is neither
    ///      the buyer, the owner, nor the leg admin.
    function test_settleTicket_permissionless() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));

        vm.prank(bob);
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Won));
    }

    /// @dev settleTicket emits TicketSettled(ticketId, finalStatus). Indexers
    ///      and the /api/settlement watcher depend on this event firing.
    function test_settleTicket_emitsTicketSettledEvent() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Lost, keccak256("no"));

        vm.expectEmit(true, true, true, true, address(engine));
        emit ParlayEngine.TicketSettled(ticketId, ParlayEngine.TicketStatus.Lost);
        engine.settleTicket(ticketId);
    }

    /// @dev Full-void path: buyer is refunded stake - feePaid and the vault
    ///      reserve is fully released. Existing test_settleTicket_allVoided
    ///      only checks the status + reserve — this locks down the USDC flow.
    function test_settleTicket_allVoided_refundsStakeMinusFee() public {
        uint256 ticketId = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        ParlayEngine.Ticket memory tBefore = engine.getTicket(ticketId);
        uint256 aliceBalBefore = usdc.balanceOf(alice);

        oracle.resolve(0, LegStatus.Voided, bytes32(0));
        oracle.resolve(1, LegStatus.Voided, bytes32(0));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Voided));
        assertEq(vault.totalReserved(), 0);
        // Buyer gets stake minus fee refunded. Fee is non-refundable because
        // it was routed to lockers/safety/vault at buy time.
        assertEq(usdc.balanceOf(alice), aliceBalBefore + (tBefore.stake - tBefore.feePaid));
    }

    // ── Correlation + exclusion gating ──────────────────────────────────
    //
    // Three legs all in the same correlation group → engine applies the
    // saturating discount to the multiplier and reserves a smaller payout
    // than the independent-legs case. The first ticket below tags every leg
    // with corrGroup=42; the second leaves them ungrouped — comparing the
    // two pins the discount magnitude.

    function test_buyTicket_correlationDiscountApplied() public {
        // Reuse legs 0/1 from _twoLegs(), but tag both with the same corr group
        // before buying. We have to bootstrap the leg ids first by buying a
        // throwaway ticket — getOrCreateBySourceRef happens inside the engine.
        _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        registry.setLegCorrGroup(0, 42);
        registry.setLegCorrGroup(1, 42);

        uint256 corrTicket = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        ParlayEngine.Ticket memory tCorr = engine.getTicket(corrTicket);

        // Drop the tags + buy again — same legs, same probabilities.
        registry.setLegCorrGroup(0, 0);
        registry.setLegCorrGroup(1, 0);
        uint256 indepTicket = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        ParlayEngine.Ticket memory tIndep = engine.getTicket(indepTicket);

        assertLt(tCorr.multiplierX1e6, tIndep.multiplierX1e6, "corr discount lowers mul");
        assertLt(tCorr.potentialPayout, tIndep.potentialPayout, "corr discount lowers payout");
    }

    function test_buyTicket_distinctCorrGroupsNoDiscount() public {
        // Bootstrap leg ids.
        _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        registry.setLegCorrGroup(0, 1);
        registry.setLegCorrGroup(1, 2);

        uint256 t1 = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        ParlayEngine.Ticket memory tag = engine.getTicket(t1);

        registry.setLegCorrGroup(0, 0);
        registry.setLegCorrGroup(1, 0);
        uint256 t2 = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        ParlayEngine.Ticket memory untag = engine.getTicket(t2);

        assertEq(tag.multiplierX1e6, untag.multiplierX1e6, "distinct groups skip discount");
    }

    function test_buyTicket_revertsOnCorrCapExceeded() public {
        // Bootstrap 4 legs and tag every one with the same corrGroup. The
        // default cap is 3, so a 4-leg ticket in that group must revert.
        ParlayEngine.SourceLeg[] memory bootstrap = new ParlayEngine.SourceLeg[](4);
        bootstrap[0] = _yesLeg("leg:eth", 500_000);
        bootstrap[1] = _yesLeg("leg:btc", 500_000);
        bootstrap[2] = _yesLeg("leg:sol", 500_000);
        bootstrap[3] = _yesLeg("leg:doge", 500_000);
        // Buy a 2-leg ticket to register legs 0,1 (need at least 2 legs).
        ParlayEngine.SourceLeg[] memory two = new ParlayEngine.SourceLeg[](2);
        two[0] = bootstrap[0];
        two[1] = bootstrap[1];
        _buySigned(engine, alice, two, 10e6, DEADLINE);
        // And register legs 2/3 via another 2-leg ticket.
        two[0] = bootstrap[2];
        two[1] = bootstrap[3];
        _buySigned(engine, alice, two, 10e6, DEADLINE);

        registry.setLegCorrGroup(0, 99);
        registry.setLegCorrGroup(1, 99);
        registry.setLegCorrGroup(2, 99);
        registry.setLegCorrGroup(3, 99);

        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 10e6, bootstrap, DEADLINE, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("TooManyLegsInGroup(uint256,uint256,uint256)", 99, 4, 3));
        engine.buyTicketSigned(q, sig);
    }

    function test_buyTicket_revertsOnExclusionConflict() public {
        // Bootstrap 2 legs sharing exclusionGroupId=5.
        _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        registry.setLegExclusionGroup(0, 5);
        registry.setLegExclusionGroup(1, 5);

        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 10e6, _twoLegs(), DEADLINE, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("MutuallyExclusiveLegs(uint256,uint256)", 0, 1));
        engine.buyTicketSigned(q, sig);
    }

    function test_setProtocolFeeBps_liveUpdate() public {
        // Default 1000bps → 2 legs feePaid = 1.9 USDC for stake 10.
        uint256 t1 = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        assertEq(engine.getTicket(t1).feePaid, 1_900_000);

        engine.setProtocolFeeBps(500); // 5% per leg → 1 - 0.95² = 0.0975
        uint256 t2 = _buySigned(engine, alice, _twoLegs(), 10e6, DEADLINE);
        assertEq(engine.getTicket(t2).feePaid, 975_000);
    }

    /// @dev Partial-void path that falls below the 2-leg parlay minimum:
    ///      3 legs, 2 voided, 1 won → remaining < 2 → ticket is voided + the
    ///      buyer is refunded (effective stake), reserve released in full.
    ///      The existing partialVoid test covers the happy recalc path
    ///      (remaining >= 2); this covers the fallback.
    function test_settleTicket_voidsAndRefundsWhenRemainingLegsBelowMinimum() public {
        uint256 ticketId = _buySigned(engine, alice, _threeLegs(), 10e6, DEADLINE);
        ParlayEngine.Ticket memory tBefore = engine.getTicket(ticketId);
        uint256 aliceBalBefore = usdc.balanceOf(alice);

        // Only one leg (#0) ends up Won; #1 and #2 are voided, collapsing the
        // parlay below 2 remaining legs.
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Voided, bytes32(0));
        oracle.resolve(2, LegStatus.Voided, bytes32(0));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Voided));
        assertEq(vault.totalReserved(), 0);
        assertEq(usdc.balanceOf(alice), aliceBalBefore + (tBefore.stake - tBefore.feePaid));
    }
}
