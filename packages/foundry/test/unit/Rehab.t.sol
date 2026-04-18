// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../../src/MockUSDC.sol";
import {HouseVault} from "../../src/core/HouseVault.sol";
import {LockVaultV2} from "../../src/core/LockVaultV2.sol";
import {ILockVault} from "../../src/interfaces/ILockVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Phase 2 rehab tests: loss queue, flush, LEAST burn, tier guards.
contract RehabTest is Test {
    MockUSDC usdc;
    HouseVault vault;
    LockVaultV2 lockVault;

    address owner = address(this);
    address engine = makeAddr("engine");
    address safetyModule = makeAddr("safetyModule");
    address lp = makeAddr("lp");
    address loser = makeAddr("loser");
    address winner = makeAddr("winner"); // For PARTIAL-tier tests (Phase 3)

    uint256 constant YEAR = 365 days;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new HouseVault(IERC20(address(usdc)));
        lockVault = new LockVaultV2(vault);

        vault.setEngine(engine);
        vault.setLockVault(lockVault);
        vault.setSafetyModule(safetyModule);

        usdc.mint(lp, 10_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e6, lp);
        vm.stopPrank();
    }

    // ── distributeLoss access + queueing ─────────────────────────────────

    function test_distributeLoss_onlyEngine() public {
        vm.expectRevert("HouseVault: caller is not engine");
        vault.distributeLoss(10e6, loser, YEAR);
    }

    function test_distributeLoss_queuesStake_issuesCredit_adjustsTotalAssets() public {
        uint256 taBefore = vault.totalAssets();
        uint256 stake = 100e6;

        // Simulate engine having transferred stake into vault (normal ticket flow).
        usdc.mint(address(vault), stake);

        vm.prank(engine);
        vault.distributeLoss(stake, loser, YEAR);

        assertEq(vault.pendingLossesLength(), 1);
        assertEq(vault.pendingRehabPrincipal(), stake);
        // totalAssets reflects the rehab-carve: underlying balance grew by `stake`
        // but pendingRehabPrincipal subtracts it, so LP-view totalAssets is flat.
        assertEq(vault.totalAssets(), taBefore);
        // Credit = stake * projectedApr (6% default).
        assertEq(vault.creditBalance(loser), vault.creditFor(stake));
    }

    function test_distributeLoss_subThreshold_skipsQueue() public {
        uint256 taBefore = vault.totalAssets();
        usdc.mint(address(vault), 0.5e6);

        vm.prank(engine);
        vault.distributeLoss(0.5e6, loser, YEAR);

        assertEq(vault.pendingLossesLength(), 0);
        assertEq(vault.pendingRehabPrincipal(), 0);
        assertEq(vault.creditBalance(loser), 0);
        // Sub-threshold loss flows to LPs as implicit profit.
        assertEq(vault.totalAssets(), taBefore + 0.5e6);
    }

    function test_distributeLoss_shortDuration_reverts() public {
        vm.prank(engine);
        vm.expectRevert("HouseVault: duration too short");
        vault.distributeLoss(10e6, loser, 30 days);
    }

    function test_distributeLoss_noLockVault_silentlySkips() public {
        // Deploy fresh vault without lockVault configured.
        HouseVault v = new HouseVault(IERC20(address(usdc)));
        v.setEngine(engine);

        usdc.mint(address(v), 10e6);
        vm.prank(engine);
        v.distributeLoss(10e6, loser, YEAR);

        assertEq(v.pendingLossesLength(), 0);
        assertEq(v.pendingRehabPrincipal(), 0);
    }

    // ── flushRehabLosses ─────────────────────────────────────────────────

    function test_flushRehabLosses_drainsQueue_mintsToLockVault() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser, YEAR);

        uint256 supplyBefore = vault.totalSupply();
        uint256 taBefore = vault.totalAssets();

        vault.flushRehabLosses(0);

        assertEq(vault.pendingLossesLength(), 0);
        assertEq(vault.pendingRehabPrincipal(), 0);
        // Shares minted to LockVault — held on behalf of loser.
        assertEq(vault.balanceOf(address(lockVault)), vault.totalSupply() - supplyBefore);
        // totalAssets grows by the released pending principal.
        assertEq(vault.totalAssets(), taBefore + 100e6);
    }

    function test_flushRehabLosses_priceNeutral() public {
        // LP should see the same share price before loss and after flush.
        uint256 stake = 100e6;
        uint256 sharesBefore = vault.balanceOf(lp);
        uint256 lpAssetsBefore = vault.convertToAssets(sharesBefore);

        usdc.mint(address(vault), stake);
        vm.prank(engine);
        vault.distributeLoss(stake, loser, YEAR);
        vault.flushRehabLosses(0);

        uint256 lpAssetsAfter = vault.convertToAssets(sharesBefore);
        // Allow 1 wei rounding from virtual-offset share math.
        assertApproxEqAbs(lpAssetsAfter, lpAssetsBefore, 2);
    }

    function test_flushRehabLosses_createsLeastPosition() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser, YEAR);
        vault.flushRehabLosses(0);

        LockVaultV2.LockPosition memory pos = lockVault.getPosition(0);
        assertEq(pos.owner, loser);
        assertEq(uint8(pos.tier), uint8(ILockVault.Tier.LEAST));
        assertEq(pos.feeShareBps, 0);
        assertEq(pos.unlockAt, block.timestamp + YEAR);
        assertGt(pos.shares, 0);
    }

    function test_flushRehabLosses_partialDrain() public {
        usdc.mint(address(vault), 300e6);
        vm.startPrank(engine);
        vault.distributeLoss(100e6, loser, YEAR);
        vault.distributeLoss(100e6, loser, YEAR);
        vault.distributeLoss(100e6, loser, YEAR);
        vm.stopPrank();

        vault.flushRehabLosses(2);

        assertEq(vault.pendingLossesLength(), 1);
        assertEq(vault.pendingRehabPrincipal(), 100e6);
    }

    function test_flushRehabLosses_emptyQueue_noop() public {
        vault.flushRehabLosses(0); // does not revert, no state changes
        assertEq(vault.pendingLossesLength(), 0);
    }

    // ── rehabLock access control ─────────────────────────────────────────

    function test_rehabLock_onlyVault() public {
        vm.expectRevert("LockVaultV2: caller is not vault");
        lockVault.rehabLock(loser, 1e6, YEAR, ILockVault.Tier.LEAST);
    }

    function test_rehabLock_rejectsFullTier() public {
        // Even the vault can't use FULL via rehabLock — only voluntary `lock()`.
        vm.prank(address(vault));
        vm.expectRevert("LockVaultV2: invalid rehab tier");
        lockVault.rehabLock(loser, 1e6, YEAR, ILockVault.Tier.FULL);
    }

    function test_rehabLock_partialUnlockAtIsInfinite() public {
        // Impersonate vault to test PARTIAL path directly.
        vm.prank(lp);
        IERC20(address(vault)).transfer(address(vault), 1e6);
        vm.startPrank(address(vault));
        IERC20(address(vault)).approve(address(lockVault), 1e6);
        lockVault.rehabLock(winner, 1e6, YEAR, ILockVault.Tier.PARTIAL);
        vm.stopPrank();

        LockVaultV2.LockPosition memory pos = lockVault.getPosition(0);
        assertEq(pos.unlockAt, type(uint256).max);
        assertEq(uint8(pos.tier), uint8(ILockVault.Tier.PARTIAL));
    }

    // ── LEAST unlock + burn ──────────────────────────────────────────────

    function test_leastUnlock_burnsPrincipal_benefitsLps() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser, YEAR);
        vault.flushRehabLosses(0);

        uint256 lpSharesBefore = vault.balanceOf(lp);
        uint256 lpAssetsBefore = vault.convertToAssets(lpSharesBefore);
        uint256 lvSharesBefore = vault.balanceOf(address(lockVault));

        vm.warp(block.timestamp + YEAR);
        // Permissionless — anyone can retire an expired LEAST lock.
        address rando = makeAddr("rando");
        vm.prank(rando);
        lockVault.unlock(0);

        // LockVault's share balance dropped by the burned amount.
        assertEq(vault.balanceOf(address(lockVault)), lvSharesBefore - lvSharesBefore);
        // LP shares unchanged but entitle to strictly more USDC (supply shrank).
        assertEq(vault.balanceOf(lp), lpSharesBefore);
        uint256 lpAssetsAfter = vault.convertToAssets(lpSharesBefore);
        assertGt(lpAssetsAfter, lpAssetsBefore);
    }

    function test_leastUnlock_beforeExpiry_reverts() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser, YEAR);
        vault.flushRehabLosses(0);

        vm.expectRevert("LockVaultV2: still locked");
        lockVault.unlock(0);
    }

    // ── Tier guards on extend / earlyWithdraw ────────────────────────────

    function test_extend_rejectsLeast() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser, YEAR);
        vault.flushRehabLosses(0);

        vm.prank(loser);
        vm.expectRevert("LockVaultV2: FULL only");
        lockVault.extend(0, 30 days);
    }

    function test_earlyWithdraw_rejectsLeast() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser, YEAR);
        vault.flushRehabLosses(0);

        vm.prank(loser);
        vm.expectRevert("LockVaultV2: FULL only");
        lockVault.earlyWithdraw(0);
    }

    // ── burnFromLockVault access control ─────────────────────────────────

    function test_burnFromLockVault_onlyLockVault() public {
        vm.expectRevert("HouseVault: not lockVault");
        vault.burnFromLockVault(1e6);
    }
}
