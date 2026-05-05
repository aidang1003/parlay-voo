// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../../contracts/MockUSDC.sol";
import {HouseVault} from "../../contracts/core/HouseVault.sol";
import {LockVaultV2} from "../../contracts/core/LockVaultV2.sol";
import {ILockVault} from "../../contracts/interfaces/ILockVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Rehab tests: loss accrues to per-user claimable balance, user
///         converts it into a LEAST lock at their chosen duration.
contract RehabTest is Test {
    MockUSDC usdc;
    HouseVault vault;
    LockVaultV2 lockVault;

    address owner = address(this);
    address engine = makeAddr("engine");
    address safetyModule = makeAddr("safetyModule");
    address lp = makeAddr("lp");
    address loser = makeAddr("loser");
    address winner = makeAddr("winner");

    uint256 constant YEAR = 365 days;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new HouseVault(IERC20(address(usdc)), 8000, 1_000_000, 3);
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

    // ── distributeLoss accrual ───────────────────────────────────────────

    function test_distributeLoss_onlyEngine() public {
        vm.expectRevert("HouseVault: caller is not engine");
        vault.distributeLoss(10e6, loser);
    }

    function test_distributeLoss_accrues_doesNotIssueCredit() public {
        uint256 taBefore = vault.totalAssets();
        uint256 stake = 100e6;

        // Simulate engine having transferred stake into the vault.
        usdc.mint(address(vault), stake);

        vm.prank(engine);
        vault.distributeLoss(stake, loser);

        assertEq(vault.rehabClaimable(loser), stake);
        assertEq(vault.totalRehabClaimable(), stake);
        // totalAssets is carved by the claimable balance: USDC grew by stake
        // but totalRehabClaimable subtracts it, so LP-view totalAssets is flat.
        assertEq(vault.totalAssets(), taBefore);
        // Credit is NOT issued at accrual time — only on claim.
        assertEq(vault.creditBalance(loser), 0);
    }

    function test_distributeLoss_subThreshold_staysWithLps() public {
        uint256 taBefore = vault.totalAssets();
        usdc.mint(address(vault), 0.5e6);

        vm.prank(engine);
        vault.distributeLoss(0.5e6, loser);

        assertEq(vault.rehabClaimable(loser), 0);
        assertEq(vault.totalRehabClaimable(), 0);
        // Sub-threshold loss flows to LPs as implicit profit.
        assertEq(vault.totalAssets(), taBefore + 0.5e6);
    }

    function test_distributeLoss_multipleLosses_sum() public {
        usdc.mint(address(vault), 300e6);
        vm.startPrank(engine);
        vault.distributeLoss(100e6, loser);
        vault.distributeLoss(100e6, loser);
        vault.distributeLoss(100e6, loser);
        vm.stopPrank();

        assertEq(vault.rehabClaimable(loser), 300e6);
        assertEq(vault.totalRehabClaimable(), 300e6);
    }

    function test_distributeLoss_noLockVault_silentlySkips() public {
        HouseVault v = new HouseVault(IERC20(address(usdc)), 8000, 1_000_000, 3);
        v.setEngine(engine);

        usdc.mint(address(v), 10e6);
        vm.prank(engine);
        v.distributeLoss(10e6, loser);

        assertEq(v.rehabClaimable(loser), 0);
        assertEq(v.totalRehabClaimable(), 0);
    }

    // ── claimRehab ───────────────────────────────────────────────────────

    function test_claimRehab_nothingToClaim_reverts() public {
        vm.prank(loser);
        vm.expectRevert("HouseVault: nothing to claim");
        vault.claimRehab(YEAR);
    }

    function test_claimRehab_shortDuration_reverts() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser);

        vm.prank(loser);
        vm.expectRevert("HouseVault: duration too short");
        vault.claimRehab(30 days);
    }

    function test_claimRehab_createsLeastLock_issuesCredit_consumesClaim() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser);

        uint256 supplyBefore = vault.totalSupply();

        vm.prank(loser);
        vault.claimRehab(YEAR);

        // Balance consumed.
        assertEq(vault.rehabClaimable(loser), 0);
        assertEq(vault.totalRehabClaimable(), 0);
        // LockVault holds the freshly-minted shares.
        assertEq(vault.balanceOf(address(lockVault)), vault.totalSupply() - supplyBefore);
        // Credit issued at claim time only (stake × projectedApr).
        assertEq(vault.creditBalance(loser), vault.creditFor(100e6));
        // LEAST position created at the chosen duration.
        LockVaultV2.LockPosition memory pos = lockVault.getPosition(0);
        assertEq(pos.owner, loser);
        assertEq(uint8(pos.tier), uint8(ILockVault.Tier.LEAST));
        assertEq(pos.unlockAt, block.timestamp + YEAR);
    }

    function test_claimRehab_userPicksLongerDuration() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser);

        uint256 fiveYears = 5 * YEAR;

        vm.prank(loser);
        vault.claimRehab(fiveYears);

        // Credit is 12mo of yield regardless of chosen duration.
        assertEq(vault.creditBalance(loser), vault.creditFor(100e6));
        LockVaultV2.LockPosition memory pos = lockVault.getPosition(0);
        assertEq(pos.unlockAt, block.timestamp + fiveYears);
    }

    function test_claimRehab_priceNeutral() public {
        uint256 stake = 100e6;
        uint256 sharesBefore = vault.balanceOf(lp);
        uint256 lpAssetsBefore = vault.convertToAssets(sharesBefore);

        usdc.mint(address(vault), stake);
        vm.prank(engine);
        vault.distributeLoss(stake, loser);

        vm.prank(loser);
        vault.claimRehab(YEAR);

        uint256 lpAssetsAfter = vault.convertToAssets(sharesBefore);
        // Allow 1 wei rounding from virtual-offset share math.
        assertApproxEqAbs(lpAssetsAfter, lpAssetsBefore, 2);
    }

    function test_claimRehab_claimsEntireAccrual() public {
        usdc.mint(address(vault), 300e6);
        vm.startPrank(engine);
        vault.distributeLoss(100e6, loser);
        vault.distributeLoss(100e6, loser);
        vault.distributeLoss(100e6, loser);
        vm.stopPrank();

        vm.prank(loser);
        vault.claimRehab(YEAR);

        assertEq(vault.rehabClaimable(loser), 0);
        assertEq(vault.creditBalance(loser), vault.creditFor(300e6));
    }

    // ── rehabLock access control (unchanged) ─────────────────────────────

    function test_rehabLock_onlyVault() public {
        vm.expectRevert("LockVaultV2: caller is not vault");
        lockVault.rehabLock(loser, 1e6, YEAR, ILockVault.Tier.LEAST);
    }

    function test_rehabLock_rejectsFullTier() public {
        vm.prank(address(vault));
        vm.expectRevert("LockVaultV2: invalid rehab tier");
        lockVault.rehabLock(loser, 1e6, YEAR, ILockVault.Tier.FULL);
    }

    function test_rehabLock_partialUnlockAtIsInfinite() public {
        vm.prank(lp);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
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
        vault.distributeLoss(100e6, loser);
        vm.prank(loser);
        vault.claimRehab(YEAR);

        uint256 lpSharesBefore = vault.balanceOf(lp);
        uint256 lpAssetsBefore = vault.convertToAssets(lpSharesBefore);
        uint256 lvSharesBefore = vault.balanceOf(address(lockVault));

        vm.warp(block.timestamp + YEAR);
        address rando = makeAddr("rando");
        vm.prank(rando);
        lockVault.unlock(0);

        assertEq(vault.balanceOf(address(lockVault)), lvSharesBefore - lvSharesBefore);
        assertEq(vault.balanceOf(lp), lpSharesBefore);
        uint256 lpAssetsAfter = vault.convertToAssets(lpSharesBefore);
        assertGt(lpAssetsAfter, lpAssetsBefore);
    }

    function test_leastUnlock_beforeExpiry_reverts() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser);
        vm.prank(loser);
        vault.claimRehab(YEAR);

        vm.expectRevert("LockVaultV2: still locked");
        lockVault.unlock(0);
    }

    // ── Tier guards on extend / earlyWithdraw ────────────────────────────

    function test_extend_rejectsLeast() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser);
        vm.prank(loser);
        vault.claimRehab(YEAR);

        vm.prank(loser);
        vm.expectRevert("LockVaultV2: FULL only");
        lockVault.extend(0, 30 days);
    }

    function test_earlyWithdraw_rejectsLeast() public {
        usdc.mint(address(vault), 100e6);
        vm.prank(engine);
        vault.distributeLoss(100e6, loser);
        vm.prank(loser);
        vault.claimRehab(YEAR);

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
