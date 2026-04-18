// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {HouseVault} from "./HouseVault.sol";
import {ILockVault} from "../interfaces/ILockVault.sol";

/// @title LockVaultV2
/// @notice Continuous-duration successor to LockVault. Fee share is an
///         asymptotic function of committed duration:
///
///             feeShareBps = 10_000 + MAX_BOOST * d / (d + HALF_LIFE)
///
///         Base 1.0x at d=MIN, asymptote 4.0x as d→∞, exactly 2.0x at 1 year.
///         No hard duration cap — diminishing returns do the shaping.
///
///         Curve parameters are immutable constants. Tuning requires a new
///         deployment; LPs can trust the math is locked from deploy.
contract LockVaultV2 is Ownable, ReentrancyGuard, ILockVault {
    using SafeERC20 for IERC20;

    // ── Structs ──────────────────────────────────────────────────────────

    struct LockPosition {
        address owner;
        uint256 shares;        // vUSDC shares locked
        uint256 duration;      // total committed duration in seconds, from lockedAt
        uint256 lockedAt;
        uint256 unlockAt;
        uint256 feeShareBps;   // 10_000 = 1.0x base, 40_000 = 4.0x asymptote
        uint256 rewardDebt;    // accRewardPerWeightedShare snapshot at entry/update
    }

    // ── Constants ────────────────────────────────────────────────────────

    uint256 private constant PRECISION = 1e18;
    uint256 private constant BPS_BASE = 10_000;

    uint256 public constant MIN_LOCK = 1e6;                 // 1 vUSDC
    uint256 public constant MIN_LOCK_DURATION = 7 days;
    uint256 public constant HALF_LIFE_SECS = 730 days;      // 2 years — controls curve knee
    uint256 public constant MAX_BOOST_BPS = 30_000;         // asymptote adds +3.0x → 4.0x total
    uint256 public constant MAX_PENALTY_BPS = 3_000;        // 30% asymptote on day-0 max-lock exit

    // ── State ────────────────────────────────────────────────────────────

    HouseVault public immutable vault;
    IERC20 public immutable vUSDC;

    mapping(uint256 => LockPosition) public positions;
    uint256 public nextPositionId;

    uint256 public accRewardPerWeightedShare;
    uint256 public totalWeightedShares;
    uint256 public totalLockedShares;

    address public feeDistributor;
    uint256 public undistributedFees;

    mapping(address => uint256) public pendingRewards;

    // ── Events ───────────────────────────────────────────────────────────

    event Locked(
        uint256 indexed positionId,
        address indexed owner,
        uint256 shares,
        uint256 duration,
        uint256 feeShareBps,
        uint256 unlockAt
    );
    event Extended(
        uint256 indexed positionId,
        uint256 additionalDuration,
        uint256 newDuration,
        uint256 newFeeShareBps,
        uint256 newUnlockAt
    );
    event Unlocked(uint256 indexed positionId, address indexed owner, uint256 shares);
    event EarlyWithdraw(
        uint256 indexed positionId,
        address indexed owner,
        uint256 sharesReturned,
        uint256 penaltyShares
    );
    event PenaltySharesSwept(address indexed receiver, uint256 shares);
    event FeesDistributed(uint256 amount, uint256 newAccRewardPerWeightedShare);
    event RewardsClaimed(address indexed user, uint256 amount);
    event Harvested(uint256 indexed positionId, address indexed owner, uint256 reward);
    event FeeDistributorSet(address indexed distributor);

    // ── Constructor ──────────────────────────────────────────────────────

    constructor(HouseVault _vault) Ownable(msg.sender) {
        vault = _vault;
        vUSDC = IERC20(address(_vault));
    }

    // ── Admin ────────────────────────────────────────────────────────────

    function setFeeDistributor(address _distributor) external onlyOwner {
        require(_distributor != address(0), "LockVaultV2: zero address");
        feeDistributor = _distributor;
        emit FeeDistributorSet(_distributor);
    }

    // ── Pure Math ────────────────────────────────────────────────────────

    /// @notice Fee-share multiplier (BPS) for a given lock duration.
    ///         feeShareBps = 10_000 + 30_000 * d / (d + 730 days).
    function feeShareForDuration(uint256 duration) public pure returns (uint256) {
        require(duration >= MIN_LOCK_DURATION, "LockVaultV2: duration below minimum");
        uint256 boost = (MAX_BOOST_BPS * duration) / (duration + HALF_LIFE_SECS);
        return BPS_BASE + boost;
    }

    /// @notice Penalty (BPS) on an early-exit given remaining lock time.
    ///         Same asymptotic shape, applied to `remaining` instead of `duration`.
    function penaltyBpsForRemaining(uint256 remaining) public pure returns (uint256) {
        if (remaining == 0) return 0;
        return (MAX_PENALTY_BPS * remaining) / (remaining + HALF_LIFE_SECS);
    }

    // ── Core ─────────────────────────────────────────────────────────────

    /// @notice Lock vUSDC shares for a caller-chosen duration.
    function lock(uint256 shares, uint256 duration) external nonReentrant returns (uint256 positionId) {
        require(shares >= MIN_LOCK, "LockVaultV2: lock below minimum");
        uint256 fsBps = feeShareForDuration(duration); // reverts on duration < MIN

        vUSDC.safeTransferFrom(msg.sender, address(this), shares);

        uint256 weighted = (shares * fsBps) / BPS_BASE;

        // Sweep undistributed fees to EXISTING lockers before adding the new one
        // so the new locker does not receive fees that accrued before they joined.
        if (undistributedFees > 0 && totalWeightedShares > 0) {
            uint256 fees = undistributedFees;
            undistributedFees = 0;
            accRewardPerWeightedShare += (fees * PRECISION) / totalWeightedShares;
            emit FeesDistributed(fees, accRewardPerWeightedShare);
        }

        totalWeightedShares += weighted;
        totalLockedShares += shares;

        positionId = nextPositionId++;
        positions[positionId] = LockPosition({
            owner: msg.sender,
            shares: shares,
            duration: duration,
            lockedAt: block.timestamp,
            unlockAt: block.timestamp + duration,
            feeShareBps: fsBps,
            rewardDebt: (weighted * accRewardPerWeightedShare) / PRECISION
        });

        // First-locker bootstrap: fees that accrued while totalWeightedShares was 0
        // are assigned to the first locker — otherwise those fees are stranded.
        if (undistributedFees > 0) {
            uint256 fees = undistributedFees;
            undistributedFees = 0;
            accRewardPerWeightedShare += (fees * PRECISION) / totalWeightedShares;
            emit FeesDistributed(fees, accRewardPerWeightedShare);
        }

        emit Locked(positionId, msg.sender, shares, duration, fsBps, block.timestamp + duration);
    }

    /// @notice Extend an existing position by `additionalDuration`. Weight is
    ///         recomputed from the new total committed duration. Pending
    ///         rewards are settled at the old weight before the new one takes
    ///         effect — guarantees no retroactive credit from the bump.
    function extend(uint256 positionId, uint256 additionalDuration) external nonReentrant {
        require(additionalDuration > 0, "LockVaultV2: zero extension");
        LockPosition storage pos = positions[positionId];
        require(pos.owner == msg.sender, "LockVaultV2: not owner");
        require(pos.shares > 0, "LockVaultV2: empty position");
        require(block.timestamp < pos.unlockAt, "LockVaultV2: already matured");

        uint256 newDuration = pos.duration + additionalDuration;
        uint256 newFsBps = feeShareForDuration(newDuration);

        _settleRewards(positionId);

        uint256 oldWeighted = (pos.shares * pos.feeShareBps) / BPS_BASE;
        uint256 newWeighted = (pos.shares * newFsBps) / BPS_BASE;

        totalWeightedShares = totalWeightedShares - oldWeighted + newWeighted;

        pos.duration = newDuration;
        pos.unlockAt = pos.lockedAt + newDuration;
        pos.feeShareBps = newFsBps;
        pos.rewardDebt = (newWeighted * accRewardPerWeightedShare) / PRECISION;

        emit Extended(positionId, additionalDuration, newDuration, newFsBps, pos.unlockAt);
    }

    /// @notice Unlock shares after maturity. Full share balance returned.
    function unlock(uint256 positionId) external nonReentrant {
        LockPosition storage pos = positions[positionId];
        require(pos.owner == msg.sender, "LockVaultV2: not owner");
        require(pos.shares > 0, "LockVaultV2: empty position");
        require(block.timestamp >= pos.unlockAt, "LockVaultV2: still locked");

        uint256 shares = pos.shares;
        _settleRewards(positionId);
        _removePosition(positionId);

        vUSDC.safeTransfer(msg.sender, shares);
        emit Unlocked(positionId, msg.sender, shares);
    }

    /// @notice Early withdrawal before maturity. Penalty decays to ~0 near
    ///         maturity and scales with remaining commitment at day 0.
    function earlyWithdraw(uint256 positionId) external nonReentrant {
        LockPosition storage pos = positions[positionId];
        require(pos.owner == msg.sender, "LockVaultV2: not owner");
        require(pos.shares > 0, "LockVaultV2: empty position");
        require(block.timestamp < pos.unlockAt, "LockVaultV2: already matured");

        uint256 shares = pos.shares;
        _settleRewards(positionId);

        uint256 remaining = pos.unlockAt - block.timestamp;
        uint256 pBps = penaltyBpsForRemaining(remaining);
        uint256 penaltyShares = (shares * pBps) / BPS_BASE;
        uint256 returned = shares - penaltyShares;

        _removePosition(positionId);

        vUSDC.safeTransfer(msg.sender, returned);
        emit EarlyWithdraw(positionId, msg.sender, returned, penaltyShares);
    }

    /// @notice Settle accrued rewards on an active position without unlocking.
    function settleRewards(uint256 positionId) external nonReentrant {
        LockPosition storage pos = positions[positionId];
        require(pos.owner == msg.sender, "LockVaultV2: not owner");
        require(pos.shares > 0, "LockVaultV2: empty position");
        uint256 pendingBefore = pendingRewards[msg.sender];
        _settleRewards(positionId);
        uint256 reward = pendingRewards[msg.sender] - pendingBefore;
        emit Harvested(positionId, msg.sender, reward);
    }

    /// @notice Called by the fee distributor (HouseVault) after pushing USDC.
    function notifyFees(uint256 amount) external override nonReentrant {
        require(msg.sender == feeDistributor, "LockVaultV2: caller is not fee distributor");
        require(amount > 0, "LockVaultV2: zero amount");
        if (totalWeightedShares == 0) {
            undistributedFees += amount;
            return;
        }

        uint256 distributable = amount;
        if (undistributedFees > 0) {
            distributable += undistributedFees;
            undistributedFees = 0;
        }

        accRewardPerWeightedShare += (distributable * PRECISION) / totalWeightedShares;
        emit FeesDistributed(distributable, accRewardPerWeightedShare);
    }

    /// @notice Claim accumulated USDC rewards.
    function claimFees() external nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, "LockVaultV2: nothing to claim");

        pendingRewards[msg.sender] = 0;
        IERC20 usdc = vault.asset();
        usdc.safeTransfer(msg.sender, amount);

        emit RewardsClaimed(msg.sender, amount);
    }

    /// @notice Sweep accumulated penalty shares (balance above totalLockedShares).
    function sweepPenaltyShares(address receiver) external onlyOwner nonReentrant {
        require(receiver != address(0), "LockVaultV2: zero receiver");
        uint256 balance = vUSDC.balanceOf(address(this));
        require(balance > totalLockedShares, "LockVaultV2: no penalty shares");
        uint256 penaltyShares = balance - totalLockedShares;
        vUSDC.safeTransfer(receiver, penaltyShares);
        emit PenaltySharesSwept(receiver, penaltyShares);
    }

    // ── Views ────────────────────────────────────────────────────────────

    function getPosition(uint256 positionId) external view returns (LockPosition memory) {
        return positions[positionId];
    }

    function pendingReward(uint256 positionId) external view returns (uint256) {
        LockPosition memory pos = positions[positionId];
        if (pos.shares == 0) return 0;
        uint256 weighted = (pos.shares * pos.feeShareBps) / BPS_BASE;
        return ((weighted * accRewardPerWeightedShare) / PRECISION) - pos.rewardDebt;
    }

    /// @notice Current early-exit penalty (BPS) for a live position.
    function currentPenaltyBps(uint256 positionId) external view returns (uint256) {
        LockPosition memory pos = positions[positionId];
        if (pos.shares == 0 || block.timestamp >= pos.unlockAt) return 0;
        return penaltyBpsForRemaining(pos.unlockAt - block.timestamp);
    }

    // ── Internal ─────────────────────────────────────────────────────────

    function _settleRewards(uint256 positionId) internal {
        LockPosition storage pos = positions[positionId];
        uint256 weighted = (pos.shares * pos.feeShareBps) / BPS_BASE;
        uint256 accumulated = (weighted * accRewardPerWeightedShare) / PRECISION;
        uint256 pending = accumulated - pos.rewardDebt;
        if (pending > 0) {
            pendingRewards[pos.owner] += pending;
        }
        pos.rewardDebt = accumulated;
    }

    function _removePosition(uint256 positionId) internal {
        LockPosition storage pos = positions[positionId];
        uint256 weighted = (pos.shares * pos.feeShareBps) / BPS_BASE;
        totalWeightedShares -= weighted;
        totalLockedShares -= pos.shares;
        pos.shares = 0;
        pos.owner = address(0);
    }
}
