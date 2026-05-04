// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../../contracts/MockUSDC.sol";
import {HouseVault} from "../../contracts/core/HouseVault.sol";
import {LockVaultV2} from "../../contracts/core/LockVaultV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract LockVaultV2Test is Test {
    MockUSDC usdc;
    HouseVault vault;
    LockVaultV2 lockVault;

    address owner = address(this);
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant SECS_PER_DAY = 86_400;
    uint256 constant YEAR = 365 * SECS_PER_DAY;
    uint256 constant HALF_LIFE = 730 * SECS_PER_DAY;

    function _mintBulk(address to, uint256 amount) internal {
        uint256 perCall = 10_000e6;
        while (amount > 0) {
            uint256 batch = amount > perCall ? perCall : amount;
            usdc.mint(to, batch);
            amount -= batch;
        }
    }

    function setUp() public {
        usdc = new MockUSDC();
        vault = new HouseVault(IERC20(address(usdc)), 8000, 1_000_000, 3);
        lockVault = new LockVaultV2(vault);

        _mintBulk(alice, 50_000e6);
        _mintBulk(bob, 50_000e6);

        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e6, alice);
        IERC20(address(vault)).approve(address(lockVault), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e6, bob);
        IERC20(address(vault)).approve(address(lockVault), type(uint256).max);
        vm.stopPrank();

        lockVault.setFeeDistributor(address(this));
    }

    function _pushFees(uint256 amount) internal {
        usdc.mint(address(lockVault), amount);
        lockVault.notifyFees(amount);
    }

    // ── Pure math ─────────────────────────────────────────────────────────

    function test_feeShareForDuration_atMinimum() public view {
        uint256 min = 7 days;
        uint256 expected = 10_000 + (30_000 * min) / (min + HALF_LIFE);
        assertEq(lockVault.feeShareForDuration(min), expected);
    }

    function test_feeShareForDuration_1yr_isExactly2x() public view {
        assertEq(lockVault.feeShareForDuration(YEAR), 20_000);
    }

    function test_feeShareForDuration_2yr_is2_5x() public view {
        assertEq(lockVault.feeShareForDuration(2 * YEAR), 25_000);
    }

    function test_feeShareForDuration_5yr() public view {
        assertEq(lockVault.feeShareForDuration(5 * YEAR), 31_428);
    }

    function test_feeShareForDuration_10yr() public view {
        assertEq(lockVault.feeShareForDuration(10 * YEAR), 35_000);
    }

    function test_feeShareForDuration_revertsBelowMin() public {
        vm.expectRevert("LockVaultV2: duration below minimum");
        lockVault.feeShareForDuration(6 days);
    }

    function test_penaltyBpsForRemaining_zeroIsZero() public view {
        assertEq(lockVault.penaltyBpsForRemaining(0), 0);
    }

    function test_penaltyBpsForRemaining_1yr() public view {
        assertEq(lockVault.penaltyBpsForRemaining(YEAR), 1_000);
    }

    function test_penaltyBpsForRemaining_5yr() public view {
        assertEq(lockVault.penaltyBpsForRemaining(5 * YEAR), 2_142);
    }

    // ── Lock ──────────────────────────────────────────────────────────────

    function test_lock_basic() public {
        vm.prank(alice);
        uint256 posId = lockVault.lock(1000e6, YEAR);

        LockVaultV2.LockPosition memory pos = lockVault.getPosition(posId);
        assertEq(pos.owner, alice);
        assertEq(pos.shares, 1000e6);
        assertEq(pos.duration, YEAR);
        assertEq(pos.feeShareBps, 20_000);
        assertEq(pos.unlockAt, block.timestamp + YEAR);
        assertEq(lockVault.totalLockedShares(), 1000e6);
        assertEq(lockVault.totalWeightedShares(), (1000e6 * 20_000) / 10_000);
    }

    function test_lock_continuousDurations() public {
        vm.startPrank(alice);
        uint256 pid90 = lockVault.lock(1000e6, 90 days);
        uint256 pid91 = lockVault.lock(1000e6, 91 days);
        vm.stopPrank();

        uint256 fs90 = lockVault.getPosition(pid90).feeShareBps;
        uint256 fs91 = lockVault.getPosition(pid91).feeShareBps;
        assertGt(fs91, fs90);
    }

    function test_lock_revertsBelowMinDuration() public {
        vm.prank(alice);
        vm.expectRevert("LockVaultV2: duration below minimum");
        lockVault.lock(1000e6, 6 days);
    }

    function test_lock_revertsBelowMinShares() public {
        vm.prank(alice);
        vm.expectRevert("LockVaultV2: lock below minimum");
        lockVault.lock(1e5, 30 days);
    }

    // ── Extend ────────────────────────────────────────────────────────────

    function test_extend_increasesFeeShare() public {
        vm.startPrank(alice);
        uint256 posId = lockVault.lock(1000e6, 90 days);
        uint256 fsBefore = lockVault.getPosition(posId).feeShareBps;

        lockVault.extend(posId, 275 days);
        vm.stopPrank();

        LockVaultV2.LockPosition memory pos = lockVault.getPosition(posId);
        assertEq(pos.duration, 365 days);
        assertEq(pos.feeShareBps, 20_000);
        assertGt(pos.feeShareBps, fsBefore);
        assertEq(pos.unlockAt, pos.lockedAt + 365 days);
    }

    function test_extend_revertsAfterMaturity() public {
        vm.prank(alice);
        uint256 posId = lockVault.lock(1000e6, 30 days);
        vm.warp(block.timestamp + 30 days);

        vm.prank(alice);
        vm.expectRevert("LockVaultV2: already matured");
        lockVault.extend(posId, 30 days);
    }

    function test_extend_onlyOwner() public {
        vm.prank(alice);
        uint256 posId = lockVault.lock(1000e6, 30 days);

        vm.prank(bob);
        vm.expectRevert("LockVaultV2: not owner");
        lockVault.extend(posId, 30 days);
    }

    // ── Unlock ────────────────────────────────────────────────────────────

    function test_unlock_afterMaturity() public {
        vm.prank(alice);
        uint256 posId = lockVault.lock(1000e6, 30 days);

        uint256 aliceBefore = IERC20(address(vault)).balanceOf(alice);
        vm.warp(block.timestamp + 30 days);

        vm.prank(alice);
        lockVault.unlock(posId);

        assertEq(IERC20(address(vault)).balanceOf(alice) - aliceBefore, 1000e6);
        assertEq(lockVault.totalLockedShares(), 0);
        assertEq(lockVault.totalWeightedShares(), 0);
    }

    function test_unlock_revertsBeforeMaturity() public {
        vm.prank(alice);
        uint256 posId = lockVault.lock(1000e6, 30 days);

        vm.prank(alice);
        vm.expectRevert("LockVaultV2: still locked");
        lockVault.unlock(posId);
    }

    // ── Early withdraw ────────────────────────────────────────────────────

    function test_earlyWithdraw_day0_longLock_sizablePenalty() public {
        vm.prank(alice);
        uint256 posId = lockVault.lock(1000e6, YEAR);

        uint256 aliceBefore = IERC20(address(vault)).balanceOf(alice);

        vm.prank(alice);
        lockVault.earlyWithdraw(posId);

        uint256 returned = IERC20(address(vault)).balanceOf(alice) - aliceBefore;
        assertApproxEqAbs(returned, 900e6, 1e6);
        assertLt(returned, 1000e6);
    }

    function test_earlyWithdraw_penaltyDecaysNearMaturity() public {
        vm.prank(alice);
        uint256 posId = lockVault.lock(1000e6, YEAR);

        vm.warp(block.timestamp + YEAR - 1 days);

        uint256 aliceBefore = IERC20(address(vault)).balanceOf(alice);
        vm.prank(alice);
        lockVault.earlyWithdraw(posId);

        uint256 returned = IERC20(address(vault)).balanceOf(alice) - aliceBefore;
        assertGt(returned, 999_500_000);
    }

    function test_earlyWithdraw_penaltyScalesWithCommitment() public {
        vm.startPrank(alice);
        uint256 shortId = lockVault.lock(1000e6, 30 days);
        uint256 longId = lockVault.lock(1000e6, 5 * YEAR);
        vm.stopPrank();

        uint256 pShort = lockVault.currentPenaltyBps(shortId);
        uint256 pLong = lockVault.currentPenaltyBps(longId);
        assertGt(pLong, pShort);
    }

    // ── Fee distribution ──────────────────────────────────────────────────

    function test_notifyFees_singleLocker_getsAll() public {
        vm.prank(alice);
        uint256 posId = lockVault.lock(1000e6, YEAR);

        _pushFees(100e6);

        vm.prank(alice);
        lockVault.settleRewards(posId);
        assertEq(lockVault.pendingRewards(alice), 100e6);
    }

    function test_notifyFees_splitByFeeShare() public {
        vm.prank(alice);
        uint256 aId = lockVault.lock(1000e6, YEAR);
        vm.prank(bob);
        uint256 bId = lockVault.lock(1000e6, 2 * YEAR);

        _pushFees(4500e6);

        vm.prank(alice);
        lockVault.settleRewards(aId);
        vm.prank(bob);
        lockVault.settleRewards(bId);

        assertApproxEqAbs(lockVault.pendingRewards(alice), 2000e6, 1);
        assertApproxEqAbs(lockVault.pendingRewards(bob), 2500e6, 1);
    }

    function test_notifyFees_onlyDistributor() public {
        vm.prank(alice);
        vm.expectRevert("LockVaultV2: caller is not fee distributor");
        lockVault.notifyFees(1e6);
    }

    function test_notifyFees_preLockerFeesGoToFirstLocker() public {
        _pushFees(100e6);
        assertEq(lockVault.undistributedFees(), 100e6);
        assertEq(lockVault.totalWeightedShares(), 0);

        vm.prank(alice);
        uint256 posId = lockVault.lock(1000e6, YEAR);

        assertEq(lockVault.undistributedFees(), 0);

        vm.prank(alice);
        lockVault.settleRewards(posId);
        assertEq(lockVault.pendingRewards(alice), 100e6);
    }

    function test_notifyFees_newLockerDoesNotReceivePriorFees() public {
        vm.prank(alice);
        uint256 aId = lockVault.lock(1000e6, YEAR);

        _pushFees(100e6);

        vm.prank(bob);
        uint256 bId = lockVault.lock(1000e6, YEAR);

        vm.prank(bob);
        lockVault.settleRewards(bId);
        assertEq(lockVault.pendingRewards(bob), 0);

        vm.prank(alice);
        lockVault.settleRewards(aId);
        assertEq(lockVault.pendingRewards(alice), 100e6);
    }

    // ── Claim ─────────────────────────────────────────────────────────────

    function test_claimFees() public {
        vm.prank(alice);
        uint256 posId = lockVault.lock(1000e6, YEAR);
        _pushFees(50e6);
        vm.prank(alice);
        lockVault.settleRewards(posId);

        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        lockVault.claimFees();

        assertEq(usdc.balanceOf(alice) - balBefore, 50e6);
        assertEq(lockVault.pendingRewards(alice), 0);
    }

    function test_claimFees_revertsWhenNothingToClaim() public {
        vm.prank(alice);
        vm.expectRevert("LockVaultV2: nothing to claim");
        lockVault.claimFees();
    }

    // ── Sweep penalty ─────────────────────────────────────────────────────

    function test_sweepPenaltyShares() public {
        vm.prank(alice);
        uint256 posId = lockVault.lock(1000e6, YEAR);
        vm.prank(alice);
        lockVault.earlyWithdraw(posId);

        address sink = makeAddr("sink");
        uint256 balBefore = IERC20(address(vault)).balanceOf(sink);
        lockVault.sweepPenaltyShares(sink);
        uint256 swept = IERC20(address(vault)).balanceOf(sink) - balBefore;

        assertGt(swept, 90e6);
        assertLt(swept, 110e6);
    }

    function test_sweepPenaltyShares_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        lockVault.sweepPenaltyShares(alice);
    }

    // ── Fuzz ──────────────────────────────────────────────────────────────

    function testFuzz_feeShareMonotonic(uint256 d1, uint256 d2) public view {
        d1 = bound(d1, 7 days, 100 * YEAR);
        d2 = bound(d2, d1 + 1, 100 * YEAR + 1);
        assertLe(lockVault.feeShareForDuration(d1), lockVault.feeShareForDuration(d2));
    }

    function testFuzz_feeShareBelowAsymptote(uint256 d) public view {
        d = bound(d, 7 days, 1000 * YEAR);
        assertLt(lockVault.feeShareForDuration(d), 40_000);
    }

    function testFuzz_penaltyBelowAsymptote(uint256 r) public view {
        r = bound(r, 0, 1000 * YEAR);
        assertLt(lockVault.penaltyBpsForRemaining(r), 3_000);
    }

    function testFuzz_penaltyMonotonic(uint256 r1, uint256 r2) public view {
        r1 = bound(r1, 0, 100 * YEAR);
        r2 = bound(r2, r1, 100 * YEAR + 1);
        assertLe(lockVault.penaltyBpsForRemaining(r1), lockVault.penaltyBpsForRemaining(r2));
    }

    function testFuzz_weightedSharesInvariant(uint96 s1, uint96 s2, uint32 d1, uint32 d2) public {
        uint256 shares1 = bound(uint256(s1), 1e6, 5_000e6);
        uint256 shares2 = bound(uint256(s2), 1e6, 5_000e6);
        uint256 dur1 = bound(uint256(d1), 7 days, 10 * YEAR);
        uint256 dur2 = bound(uint256(d2), 7 days, 10 * YEAR);

        vm.prank(alice);
        uint256 aId = lockVault.lock(shares1, dur1);
        vm.prank(bob);
        uint256 bId = lockVault.lock(shares2, dur2);

        uint256 expectedTotal = (shares1 * lockVault.feeShareForDuration(dur1)) / 10_000
            + (shares2 * lockVault.feeShareForDuration(dur2)) / 10_000;
        assertEq(lockVault.totalWeightedShares(), expectedTotal);
        assertEq(lockVault.totalLockedShares(), shares1 + shares2);

        vm.warp(block.timestamp + 10 * YEAR + 1);
        vm.prank(alice);
        lockVault.unlock(aId);
        vm.prank(bob);
        lockVault.unlock(bId);

        assertEq(lockVault.totalWeightedShares(), 0);
        assertEq(lockVault.totalLockedShares(), 0);
    }
}
