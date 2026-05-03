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

contract EarlyCashoutTest is FeeRouterSetup, SignedBuy {
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

        usdc.mint(bob, 1_000e6);
        vm.prank(bob);
        usdc.approve(address(engine), type(uint256).max);
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _yesLeg(string memory ref, uint256 ppm) internal view returns (ParlayEngine.SourceLeg memory) {
        return _mkLeg(ref, bytes32(uint256(1)), ppm, address(oracle), CUTOFF, RESOLVE);
    }

    /// @dev Buy a 3-leg ticket (50%+25%+20%). Legs 0,1,2 are created on first
    ///      call.
    function _buy3Leg() internal returns (uint256 ticketId) {
        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](3);
        legs[0] = _yesLeg("leg:eth", 500_000);
        legs[1] = _yesLeg("leg:btc", 250_000);
        legs[2] = _yesLeg("leg:sol", 200_000);
        ticketId = _buySigned(engine, alice, legs, 10e6, DEADLINE);
    }

    function _buy5Leg() internal returns (uint256 ticketId) {
        // Need more vault liquidity for 5-leg multiplier
        for (uint256 j = 0; j < 9; j++) {
            usdc.mint(owner, 10_000e6);
        }
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(90_000e6, owner);

        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](5);
        legs[0] = _yesLeg("leg:eth", 500_000);
        legs[1] = _yesLeg("leg:btc", 250_000);
        legs[2] = _yesLeg("leg:sol", 200_000);
        legs[3] = _yesLeg("leg:doge", 400_000);
        legs[4] = _yesLeg("leg:avax", 500_000);
        ticketId = _buySigned(engine, alice, legs, 10e6, DEADLINE);
    }

    // ── 1. Basic cashout ─────────────────────────────────────────────────

    function test_cashoutEarly_basic() public {
        uint256 ticketId = _buy3Leg();

        // 3 legs at 1000bps fee → effective fee = 1 - 0.9³ = 0.271, so feePaid =
        // 10 × 0.271 = 2.71 USDC. effectiveStake = stake × 0.9³ = 7.29 USDC.
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(t.feePaid, 2_710_000);
        assertEq(t.stake - t.feePaid, 7_290_000);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 reservedBefore = vault.totalReserved();

        vm.prank(alice);
        engine.cashoutEarly(ticketId, 0);

        // wonMult = 1/0.5 = 2x. fairValue = 7.29 × 2 = 14.58 USDC. penalty bps =
        // 1500 × 2/3 = 1000 (10%). cashout = 14.58 × 0.9 = 13.122 USDC.
        uint256 expectedCashout = 13_122_000;
        assertEq(usdc.balanceOf(alice), aliceBefore + expectedCashout, "alice received cashout");

        ParlayEngine.Ticket memory tAfter = engine.getTicket(ticketId);
        assertEq(uint8(tAfter.status), uint8(ParlayEngine.TicketStatus.Claimed));
        assertEq(vault.totalReserved(), reservedBefore - t.potentialPayout, "vault reserve released");
    }

    // ── 2. Two of three won ──────────────────────────────────────────────

    function test_cashoutEarly_twoOfThreeWon() public {
        uint256 ticketId = _buy3Leg();
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        engine.cashoutEarly(ticketId, 0);

        // effectiveStake = 7.29 USDC. wonMult = 1/0.5 × 1/0.25 = 8x. fairValue =
        // 7.29 × 8 = 58.32 USDC. penalty = 1500 × 1/3 = 500 (5%). cashout =
        // 58.32 × 0.95 = 55.404 USDC.
        uint256 expectedCashout = 55_404_000;
        assertEq(usdc.balanceOf(alice), aliceBefore + expectedCashout, "alice received higher cashout");

        ParlayEngine.Ticket memory tAfter = engine.getTicket(ticketId);
        assertEq(uint8(tAfter.status), uint8(ParlayEngine.TicketStatus.Claimed));
    }

    // ── 3. Five-leg parlay ───────────────────────────────────────────────

    function test_cashoutEarly_fiveLegParlay() public {
        uint256 ticketId = _buy5Leg();

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        // 5 legs at 1000bps → 1 - 0.9⁵ = 0.40951 → 10 × 0.40951 = 4.0951 USDC.
        assertEq(t.feePaid, 4_095_100);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        oracle.resolve(2, LegStatus.Won, keccak256("yes"));

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        engine.cashoutEarly(ticketId, 0);

        uint256 received = usdc.balanceOf(alice) - aliceBefore;
        assertGt(received, 0, "received positive cashout");
        assertTrue(received < t.potentialPayout, "cashout < potential payout");

        ParlayEngine.Ticket memory tAfter = engine.getTicket(ticketId);
        assertEq(uint8(tAfter.status), uint8(ParlayEngine.TicketStatus.Claimed));
    }

    // ── 4. Slippage protection ───────────────────────────────────────────

    function test_cashoutEarly_slippageProtection() public {
        uint256 ticketId = _buy3Leg();
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: below min cashout");
        engine.cashoutEarly(ticketId, 13_122_001);
    }

    // ── 5. Leg lost reverts ──────────────────────────────────────────────

    function test_cashoutEarly_legLost_reverts() public {
        uint256 ticketId = _buy3Leg();
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Lost, keccak256("no"));

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: leg already lost");
        engine.cashoutEarly(ticketId, 0);
    }

    // ── 6. No won legs reverts ───────────────────────────────────────────

    function test_cashoutEarly_noWonLegs_reverts() public {
        uint256 ticketId = _buy3Leg();

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: need at least 1 won leg");
        engine.cashoutEarly(ticketId, 0);
    }

    // ── 7. All resolved -> use settleTicket ──────────────────────────────

    function test_cashoutEarly_allResolved_reverts() public {
        uint256 ticketId = _buy3Leg();
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        oracle.resolve(2, LegStatus.Won, keccak256("yes"));

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: all resolved, use settleTicket");
        engine.cashoutEarly(ticketId, 0);
    }

    // ── 8. Not owner reverts ─────────────────────────────────────────────

    function test_cashoutEarly_notOwner_reverts() public {
        uint256 ticketId = _buy3Leg();
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));

        vm.prank(bob);
        vm.expectRevert("ParlayEngine: not ticket owner");
        engine.cashoutEarly(ticketId, 0);
    }

    // ── 9. Not active reverts ────────────────────────────────────────────

    function test_cashoutEarly_notActive_reverts() public {
        uint256 ticketId = _buy3Leg();
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        oracle.resolve(2, LegStatus.Won, keccak256("yes"));
        engine.settleTicket(ticketId);

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: not active");
        engine.cashoutEarly(ticketId, 0);
    }

    // ── 10. Vault accounting ─────────────────────────────────────────────

    function test_cashoutEarly_vaultAccounting() public {
        uint256 vaultAssetsBefore = vault.totalAssets();
        uint256 aliceBalBefore = usdc.balanceOf(alice);

        uint256 ticketId = _buy3Leg();
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 potentialPayout = t.potentialPayout;

        assertEq(vault.totalReserved(), potentialPayout);
        // fee = 2_710_000. routed = lockers (90%) + safety (5%) = 2_574_500.
        // vault gains stake - routed = 10_000_000 - 2_574_500 = 7_425_500.
        assertEq(vault.totalAssets(), vaultAssetsBefore + 10e6 - 2_574_500);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));

        vm.prank(alice);
        engine.cashoutEarly(ticketId, 0);

        uint256 cashoutPaid = usdc.balanceOf(alice) - (aliceBalBefore - 10e6);
        assertEq(vault.totalReserved(), 0, "all reserves released");
        assertEq(vault.totalAssets(), vaultAssetsBefore + 10e6 - 2_574_500 - cashoutPaid, "vault assets correct");
        assertTrue(cashoutPaid < potentialPayout, "cashout less than potential payout");
        assertEq(cashoutPaid, 13_122_000, "cashout matches expected value");
    }

    // ── 11. Voided leg treated as unresolved ─────────────────────────────

    function test_cashoutEarly_voidedLegTreatedAsUnresolved() public {
        uint256 ticketId = _buy3Leg();
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Voided, bytes32(0));

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        engine.cashoutEarly(ticketId, 0);

        uint256 received = usdc.balanceOf(alice) - aliceBefore;
        // Same calc as test_cashoutEarly_basic — voided leg counts as unresolved.
        assertEq(received, 13_122_000, "voided leg treated as unresolved");

        ParlayEngine.Ticket memory tAfter = engine.getTicket(ticketId);
        assertEq(uint8(tAfter.status), uint8(ParlayEngine.TicketStatus.Claimed));
    }

    // ── 12. Admin can change cashoutPenaltyBps ───────────────────────────

    function test_cashoutEarly_penaltyAdmin() public {
        assertEq(engine.cashoutPenaltyBps(), 1500);

        engine.setCashoutPenalty(2000);
        assertEq(engine.cashoutPenaltyBps(), 2000);

        uint256 ticketId = _buy3Leg();
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        engine.cashoutEarly(ticketId, 0);

        // penaltyBps = 2000 × 2/3 = 1333 (13.33%)
        // fairValue = effectiveStake (7.29 USDC) × wonMult (2x) = 14_580_000
        // cashout   = 14_580_000 × 8667 / 10_000 = 12_636_486 (truncated)
        assertEq(usdc.balanceOf(alice), aliceBefore + 12_636_486, "updated penalty applied");

        vm.expectRevert("ParlayEngine: penalty too high");
        engine.setCashoutPenalty(5001);

        vm.prank(alice);
        vm.expectRevert();
        engine.setCashoutPenalty(1000);
    }

    // ── 13. EarlyCashout event emitted ───────────────────────────────────

    function test_cashoutEarly_emitsEvent() public {
        uint256 ticketId = _buy3Leg();
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));

        vm.expectEmit(true, true, false, true);
        emit ParlayEngine.EarlyCashout(ticketId, alice, 13_122_000, 1000);

        vm.prank(alice);
        engine.cashoutEarly(ticketId, 0);
    }

    // ── 14. Zero cashout value reverts (min cashout) ─────────────────────

    function test_cashoutEarly_zeroPayout_reverts() public {
        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](2);
        legs[0] = _yesLeg("leg:unlikely", 10_000); // 1%
        legs[1] = _yesLeg("leg:normal", 500_000); // 50%
        uint256 ticketId = _buySigned(engine, alice, legs, 1e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));

        vm.prank(alice);
        vm.expectRevert("ParlayEngine: below min cashout");
        engine.cashoutEarly(ticketId, type(uint256).max);
    }

    // ── 15. Cashout paused ───────────────────────────────────────────────

    function test_cashoutEarly_whenPaused_reverts() public {
        uint256 ticketId = _buy3Leg();
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));

        engine.pause();

        vm.prank(alice);
        vm.expectRevert();
        engine.cashoutEarly(ticketId, 0);
    }
}
