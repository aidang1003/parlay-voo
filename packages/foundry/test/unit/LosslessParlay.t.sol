// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "../../src/MockUSDC.sol";
import {HouseVault} from "../../src/core/HouseVault.sol";
import {LegRegistry} from "../../src/core/LegRegistry.sol";
import {ParlayEngine} from "../../src/core/ParlayEngine.sol";
import {AdminOracleAdapter} from "../../src/oracle/AdminOracleAdapter.sol";
import {LockVaultV2} from "../../src/core/LockVaultV2.sol";
import {ILockVault} from "../../src/interfaces/ILockVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LegStatus} from "../../src/interfaces/IOracleAdapter.sol";
import {SignedBuy} from "../helpers/SignedBuy.sol";

/// @notice Phase 3 integration: lossless parlay buy + settle (win / loss / voided).
///         Uses LockVaultV2 (not V1) because rehabLock is routed through there.
contract LosslessParlayTest is SignedBuy {
    MockUSDC usdc;
    HouseVault vault;
    LegRegistry registry;
    ParlayEngine engine;
    AdminOracleAdapter oracle;
    LockVaultV2 lockVault;

    address lp = makeAddr("lp");
    address bettor = makeAddr("bettor");
    address safetyModule = makeAddr("safetyModule");

    uint256 constant CUTOFF = 200_000;
    uint256 constant RESOLVE = 300_000;
    uint256 constant DEADLINE = 150_000;
    uint256 constant CREDIT = 100e6; // $100 credit

    function setUp() public {
        vm.warp(100_000);

        usdc = new MockUSDC();
        vault = new HouseVault(IERC20(address(usdc)));
        registry = new LegRegistry();
        oracle = new AdminOracleAdapter();
        engine = new ParlayEngine(vault, registry, IERC20(address(usdc)), 1_000_000);

        vault.setEngine(address(engine));
        registry.setEngine(address(engine));
        engine.setTrustedQuoteSigner(_signerAddr());

        lockVault = new LockVaultV2(vault);
        vault.setLockVault(lockVault);
        vault.setSafetyModule(safetyModule);
        lockVault.setFeeDistributor(address(vault));

        usdc.mint(lp, 10_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e6, lp);
        vm.stopPrank();

        // Give bettor some credit by simulating an engine-originated loss.
        uint256 principal = CREDIT * 10_000 / vault.projectedAprBps(); // 100 * 10000/600 = 1666.67e6
        uint256 minDuration = vault.MIN_REHAB_DURATION();
        usdc.mint(address(vault), principal);
        vm.prank(address(engine));
        vault.distributeLoss(principal, bettor, minDuration);
        // creditBalance[bettor] = principal * 6% ≈ $100.
        assertEq(vault.creditBalance(bettor), vault.creditFor(principal));
    }

    function _twoLegs() internal view returns (ParlayEngine.SourceLeg[] memory l) {
        l = new ParlayEngine.SourceLeg[](2);
        l[0] = _mkLeg("src:eth", bytes32(uint256(1)), 500_000, address(oracle), CUTOFF, RESOLVE);
        l[1] = _mkLeg("src:btc", bytes32(uint256(1)), 500_000, address(oracle), CUTOFF, RESOLVE);
    }

    function _threeLegs() internal view returns (ParlayEngine.SourceLeg[] memory l) {
        l = new ParlayEngine.SourceLeg[](3);
        l[0] = _mkLeg("src:eth", bytes32(uint256(1)), 500_000, address(oracle), CUTOFF, RESOLVE);
        l[1] = _mkLeg("src:btc", bytes32(uint256(1)), 500_000, address(oracle), CUTOFF, RESOLVE);
        l[2] = _mkLeg("src:sol", bytes32(uint256(1)), 500_000, address(oracle), CUTOFF, RESOLVE);
    }

    // ── buyLosslessParlay ────────────────────────────────────────────────

    function test_buyLossless_spendsCredit_noUsdc_noFee() public {
        uint256 usdcBefore = usdc.balanceOf(bettor);
        uint256 creditBefore = vault.creditBalance(bettor);

        uint256 ticketId = _buyLossless(engine, bettor, _twoLegs(), 10e6, DEADLINE);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertTrue(t.isLossless, "flagged lossless");
        assertEq(t.feePaid, 0, "no fee on lossless");
        assertEq(t.stake, 10e6);
        // USDC unchanged, credit deducted.
        assertEq(usdc.balanceOf(bettor), usdcBefore);
        assertEq(vault.creditBalance(bettor), creditBefore - 10e6);
    }

    function test_buyLossless_insufficientCredit_reverts() public {
        // Stake 110e6 → payout 440e6 (under 5% maxPayout=500e6 cap) but above
        // credit balance (~100e6). spendCredit must be the first failing check.
        // Build + sign the quote up front so `expectRevert` targets only the
        // buyLosslessParlay call (not the domainSeparator view used during hashing).
        ParlayEngine.Quote memory q = _mkQuote(bettor, 110e6, _twoLegs(), DEADLINE, _nextQuoteNonce++);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);
        vm.prank(bettor);
        vm.expectRevert("HouseVault: insufficient credit");
        engine.buyLosslessParlay(q, sig);
    }

    function test_spendCredit_onlyEngine() public {
        vm.expectRevert("HouseVault: caller is not engine");
        vault.spendCredit(bettor, 10e6);
    }

    function test_refundCredit_onlyEngine() public {
        vm.expectRevert("HouseVault: caller is not engine");
        vault.refundCredit(bettor, 10e6);
    }

    // ── settle: win → PARTIAL lock ───────────────────────────────────────

    function test_losslessWin_mintsPartialLock_autoClaims() public {
        uint256 ticketId = _buyLossless(engine, bettor, _twoLegs(), 10e6, DEADLINE);
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory tAfter = engine.getTicket(ticketId);
        assertEq(uint8(tAfter.status), uint8(ParlayEngine.TicketStatus.Claimed), "auto-claimed on lossless win");
        // User received a PARTIAL lock (position 0 is created when flushed; but
        // lossless-win skips the queue and goes straight to PARTIAL, so it's
        // the first position — we assume no prior rehabLock was created).
        // Find the position by scanning nextPositionId.
        LockVaultV2.LockPosition memory pos = lockVault.getPosition(0);
        assertEq(pos.owner, bettor);
        assertEq(uint8(pos.tier), uint8(ILockVault.Tier.PARTIAL));
        assertEq(pos.unlockAt, type(uint256).max, "PARTIAL principal never unlocks");
        assertGt(pos.shares, 0);
        assertEq(vault.totalReserved(), 0, "reservation released");
        // User received no USDC.
        // Paid nothing in USDC; no claim step needed.
        // potentialPayout on the ticket preserved for display.
        assertEq(tAfter.potentialPayout, t.potentialPayout);
    }

    function test_losslessWin_dilutesLpsByPayoutOnly() public {
        uint256 lpShares = vault.balanceOf(lp);
        uint256 lpClaimBefore = vault.convertToAssets(lpShares);

        uint256 ticketId = _buyLossless(engine, bettor, _twoLegs(), 10e6, DEADLINE);
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 payout = t.potentialPayout;

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        engine.settleTicket(ticketId);

        // By spec: lossless win mints PARTIAL shares worth `payout` at current
        // price, which dilutes LPs by at most `payout` (the bettor bet with
        // credit, not USDC — the payout backing comes from the LP pool).
        // LPs are compensated indirectly: the PARTIAL principal is locked
        // forever in the pool generating fees.
        uint256 lpClaimAfter = vault.convertToAssets(lpShares);
        uint256 lpDrop = lpClaimBefore - lpClaimAfter;
        // LP dilution is bounded by payout — share math with virtual offset
        // can trim a fraction off due to post-dilution convertToAssets.
        assertLe(lpDrop, payout, "LP dilution must not exceed payout");
        // And dilution is close to payout (within 1% — virtual offset plus
        // post-mint share-price recomputation accounts for the small gap).
        assertApproxEqRel(lpDrop, payout, 1e16, "LP dilution ~= payout");

        // Bettor's PARTIAL lock holds shares convertible to ~payout.
        LockVaultV2.LockPosition memory pos = lockVault.getPosition(0);
        assertApproxEqRel(vault.convertToAssets(pos.shares), payout, 1e16, "PARTIAL shares ~= payout");
    }

    // ── settle: loss → burns credit, no LEAST carve ──────────────────────

    function test_losslessLoss_noNewLeastLock() public {
        uint256 pendingBefore = vault.pendingRehabPrincipal();
        uint256 creditAfterBuy = vault.creditBalance(bettor); // already reduced by buy

        uint256 ticketId = _buyLossless(engine, bettor, _twoLegs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Lost, keccak256("no"));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory tAfter = engine.getTicket(ticketId);
        assertEq(uint8(tAfter.status), uint8(ParlayEngine.TicketStatus.Lost));
        // No new queued loss, no new credit.
        assertEq(vault.pendingRehabPrincipal(), pendingBefore);
        assertEq(vault.creditBalance(bettor), creditAfterBuy - 10e6);
        assertEq(vault.totalReserved(), 0);
    }

    // ── settle: all-voided → refund credit ───────────────────────────────

    function test_losslessAllVoided_refundsCredit() public {
        uint256 creditBefore = vault.creditBalance(bettor);
        uint256 ticketId = _buyLossless(engine, bettor, _twoLegs(), 10e6, DEADLINE);
        assertEq(vault.creditBalance(bettor), creditBefore - 10e6);

        oracle.resolve(0, LegStatus.Voided, bytes32(0));
        oracle.resolve(1, LegStatus.Voided, bytes32(0));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory tAfter = engine.getTicket(ticketId);
        assertEq(uint8(tAfter.status), uint8(ParlayEngine.TicketStatus.Voided));
        // Credit fully refunded.
        assertEq(vault.creditBalance(bettor), creditBefore);
        assertEq(vault.totalReserved(), 0);
    }

    // ── cashout blocked on lossless ──────────────────────────────────────

    function test_losslessCashout_reverts() public {
        uint256 ticketId = _buyLossless(engine, bettor, _twoLegs(), 10e6, DEADLINE);
        oracle.resolve(0, LegStatus.Won, keccak256("yes"));

        vm.prank(bettor);
        vm.expectRevert("ParlayEngine: no cashout on lossless");
        engine.cashoutEarly(ticketId, 0);
    }

    // ── routeLosslessWin access control ──────────────────────────────────

    function test_routeLosslessWin_onlyEngine() public {
        vm.expectRevert("HouseVault: caller is not engine");
        vault.routeLosslessWin(bettor, 10e6);
    }
}
