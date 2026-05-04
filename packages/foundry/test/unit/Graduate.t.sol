// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../../contracts/MockUSDC.sol";
import {HouseVault} from "../../contracts/core/HouseVault.sol";
import {LockVaultV2} from "../../contracts/core/LockVaultV2.sol";
import {ILockVault} from "../../contracts/interfaces/ILockVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice PARTIAL → FULL graduation: re-locking a PARTIAL position for
///         ≥24 months promotes it to FULL (gains fee-share weight + unlock
///         time + promo credit).
contract GraduateTest is Test {
    MockUSDC usdc;
    HouseVault vault;
    LockVaultV2 lockVault;

    address engine = makeAddr("engine");
    address safetyModule = makeAddr("safetyModule");
    address lp = makeAddr("lp");
    address winner = makeAddr("winner");

    uint256 constant YEAR = 365 days;
    uint256 constant TWO_YEARS = 730 days;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new HouseVault(IERC20(address(usdc)), 8000, 1_000_000, 3);
        lockVault = new LockVaultV2(vault);

        vault.setEngine(engine);
        vault.setLockVault(lockVault);
        vault.setSafetyModule(safetyModule);
        lockVault.setFeeDistributor(address(vault));

        usdc.mint(lp, 10_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e6, lp);
        vm.stopPrank();
    }

    /// @dev Mints a PARTIAL position for `user` by simulating a lossless-win
    ///      route from the vault. Returns the newly minted positionId.
    function _mintPartial(address user, uint256 voo) internal returns (uint256 positionId) {
        positionId = lockVault.nextPositionId();
        // Transfer VOO from LP to the vault, then have the vault approve the
        // lockVault and call rehabLock as itself. Mirrors routeLosslessWin
        // without going through the engine.
        vm.prank(lp);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20(address(vault)).transfer(address(vault), voo);
        vm.startPrank(address(vault));
        IERC20(address(vault)).approve(address(lockVault), voo);
        lockVault.rehabLock(user, voo, YEAR, ILockVault.Tier.PARTIAL);
        vm.stopPrank();
    }

    // ── Access control ───────────────────────────────────────────────────

    function test_graduate_onlyOwner() public {
        uint256 pid = _mintPartial(winner, 100e6);
        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert("LockVaultV2: not owner");
        lockVault.graduate(pid, TWO_YEARS);
    }

    function test_graduate_rejectsNonPartial() public {
        // Alice locks FULL voluntarily.
        address alice = makeAddr("alice");
        vm.prank(lp);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20(address(vault)).transfer(alice, 100e6);
        vm.startPrank(alice);
        IERC20(address(vault)).approve(address(lockVault), 100e6);
        uint256 pid = lockVault.lock(100e6, YEAR);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert("LockVaultV2: PARTIAL only");
        lockVault.graduate(pid, TWO_YEARS);
    }

    function test_graduate_rejectsShortDuration() public {
        uint256 pid = _mintPartial(winner, 100e6);
        vm.prank(winner);
        vm.expectRevert("LockVaultV2: graduate duration too short");
        lockVault.graduate(pid, TWO_YEARS - 1);
    }

    function test_graduate_issuePromoCredit_onlyLockVault() public {
        vm.expectRevert("HouseVault: not lockVault");
        vault.issuePromoCredit(winner, 1e6);
    }

    // ── Happy path ───────────────────────────────────────────────────────

    function test_graduate_flipsToFull_setsUnlockAndWeight() public {
        uint256 pid = _mintPartial(winner, 100e6);

        uint256 weightedBefore = lockVault.totalWeightedShares();
        uint256 lockedBefore = lockVault.totalLockedShares();

        vm.prank(winner);
        lockVault.graduate(pid, TWO_YEARS);

        LockVaultV2.LockPosition memory pos = lockVault.getPosition(pid);
        assertEq(uint8(pos.tier), uint8(ILockVault.Tier.FULL), "tier -> FULL");
        assertEq(pos.unlockAt, block.timestamp + TWO_YEARS, "unlockAt reset");
        assertEq(pos.duration, TWO_YEARS);
        assertEq(pos.lockedAt, block.timestamp, "lockedAt reset on graduation");
        assertGt(pos.feeShareBps, 0, "FULL carries fee-share weight");

        // totalLockedShares stays the same (same shares, just retiered).
        assertEq(lockVault.totalLockedShares(), lockedBefore);
        // totalWeightedShares grew by the new weighted amount.
        uint256 expectedWeighted = (pos.shares * pos.feeShareBps) / 10_000;
        assertEq(lockVault.totalWeightedShares(), weightedBefore + expectedWeighted);
    }

    function test_graduate_issuesPromoCredit() public {
        uint256 pid = _mintPartial(winner, 100e6);
        uint256 creditBefore = vault.creditBalance(winner);

        vm.prank(winner);
        lockVault.graduate(pid, TWO_YEARS);

        // Principal = convertToAssets(shares) ≈ 100e6 (LP+partial price parity at setup).
        // Credit at 6% APR on 100e6 ≈ 6e6.
        LockVaultV2.LockPosition memory pos = lockVault.getPosition(pid);
        uint256 principal = vault.convertToAssets(pos.shares);
        uint256 expected = vault.creditFor(principal);
        assertEq(vault.creditBalance(winner), creditBefore + expected, "promo credit issued");
        assertGt(expected, 0, "promo credit must be non-zero");
    }

    function test_graduate_canEarlyWithdrawAsFull() public {
        uint256 pid = _mintPartial(winner, 100e6);
        vm.prank(winner);
        lockVault.graduate(pid, TWO_YEARS);

        // After graduation FULL permits earlyWithdraw (with penalty).
        vm.prank(winner);
        lockVault.earlyWithdraw(pid);

        LockVaultV2.LockPosition memory pos = lockVault.getPosition(pid);
        assertEq(pos.shares, 0, "position retired");
        assertGt(IERC20(address(vault)).balanceOf(winner), 0, "winner received VOO minus penalty");
    }

    function test_graduate_canUnlockAtMaturityAsFull() public {
        uint256 pid = _mintPartial(winner, 100e6);
        vm.prank(winner);
        lockVault.graduate(pid, TWO_YEARS);

        vm.warp(block.timestamp + TWO_YEARS);
        vm.prank(winner);
        lockVault.unlock(pid);

        assertEq(IERC20(address(vault)).balanceOf(winner), 100e6, "full principal returned");
    }

    function test_graduate_earnsFeesAfterPromotion() public {
        uint256 pid = _mintPartial(winner, 100e6);
        vm.prank(winner);
        lockVault.graduate(pid, TWO_YEARS);

        // Push fees into lockVault via the vault's fee-distributor wiring.
        // To simplify, mint USDC directly to lockVault and call notifyFees
        // as the feeDistributor (set to the vault). We impersonate the vault.
        usdc.mint(address(lockVault), 10e6);
        vm.prank(address(vault));
        lockVault.notifyFees(10e6);

        uint256 pending = lockVault.pendingReward(pid);
        assertGt(pending, 0, "graduate earns fees");
    }

    function test_graduate_doesNotClaimPastFees() public {
        // Another FULL locker first — claims every past fee.
        address alice = makeAddr("alice");
        vm.prank(lp);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20(address(vault)).transfer(alice, 100e6);
        vm.startPrank(alice);
        IERC20(address(vault)).approve(address(lockVault), 100e6);
        uint256 alicePid = lockVault.lock(100e6, YEAR);
        vm.stopPrank();

        // Fees flow before PARTIAL exists.
        usdc.mint(address(lockVault), 10e6);
        vm.prank(address(vault));
        lockVault.notifyFees(10e6);

        uint256 alicePendingBefore = lockVault.pendingReward(alicePid);

        // Mint PARTIAL for winner, then graduate.
        uint256 pid = _mintPartial(winner, 100e6);
        vm.prank(winner);
        lockVault.graduate(pid, TWO_YEARS);

        // Winner starts at zero; Alice still entitled to all the past fees.
        assertEq(lockVault.pendingReward(pid), 0, "graduate has no retroactive claim");
        assertEq(lockVault.pendingReward(alicePid), alicePendingBefore, "alice keeps past fees");
    }

    // ── One-way ─────────────────────────────────────────────────────────

    function test_graduate_noRedoFromFull() public {
        uint256 pid = _mintPartial(winner, 100e6);
        vm.prank(winner);
        lockVault.graduate(pid, TWO_YEARS);
        vm.prank(winner);
        vm.expectRevert("LockVaultV2: PARTIAL only");
        lockVault.graduate(pid, TWO_YEARS);
    }
}
