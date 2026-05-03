// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {HouseVault} from "./HouseVault.sol";
import {ILockVault} from "../interfaces/ILockVault.sol";

/// @notice Continuous-duration VOO lock. feeShareBps = 10_000 + MAX_BOOST * d / (d + HALF_LIFE). Base 1x at MIN, 2x at 1y, 4x asymptote.
contract LockVaultV2 is Ownable, ReentrancyGuard, ILockVault {
    using SafeERC20 for IERC20;

    struct LockPosition {
        address owner;
        uint256 shares;
        uint256 duration;
        uint256 lockedAt;
        uint256 unlockAt;      // type(uint256).max for PARTIAL — principal never unlocks
        uint256 feeShareBps;   // FULL only; 0 for rehab tiers
        uint256 rewardDebt;
        ILockVault.Tier tier;
    }

    uint256 private constant PRECISION = 1e18;
    uint256 private constant BPS_BASE = 10_000;

    uint256 public constant MIN_LOCK = 1e6;
    uint256 public constant MIN_LOCK_DURATION = 7 days;
    uint256 public constant HALF_LIFE_SECS = 730 days;
    uint256 public constant MAX_BOOST_BPS = 30_000;
    uint256 public constant MAX_PENALTY_BPS = 3_000;
    uint256 public constant MIN_GRADUATE_DURATION = 730 days;

    HouseVault public immutable vault;
    IERC20 public immutable voo;

    mapping(uint256 => LockPosition) public positions;
    uint256 public nextPositionId;

    uint256 public accRewardPerWeightedShare;
    uint256 public totalWeightedShares;
    uint256 public totalLockedShares;

    address public feeDistributor;
    uint256 public undistributedFees;

    mapping(address => uint256) public pendingRewards;

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
    event RehabLocked(
        uint256 indexed positionId,
        address indexed owner,
        ILockVault.Tier indexed tier,
        uint256 shares,
        uint256 duration,
        uint256 unlockAt
    );
    event LeastPrincipalBurned(uint256 indexed positionId, address indexed formerOwner, uint256 shares);
    event Graduated(
        uint256 indexed positionId,
        address indexed owner,
        uint256 newDuration,
        uint256 newFeeShareBps,
        uint256 newUnlockAt,
        uint256 promoCredit
    );

    modifier onlyVault() {
        require(msg.sender == address(vault), "LockVaultV2: caller is not vault");
        _;
    }

    constructor(HouseVault _vault) Ownable(msg.sender) {
        vault = _vault;
        voo = IERC20(address(_vault));
    }

    function setFeeDistributor(address _distributor) external onlyOwner {
        require(_distributor != address(0), "LockVaultV2: zero address");
        feeDistributor = _distributor;
        emit FeeDistributorSet(_distributor);
    }

    /// @notice 10_000 + 30_000 * d / (d + 730 days).
    function feeShareForDuration(uint256 duration) public pure returns (uint256) {
        require(duration >= MIN_LOCK_DURATION, "LockVaultV2: duration below minimum");
        uint256 boost = (MAX_BOOST_BPS * duration) / (duration + HALF_LIFE_SECS);
        return BPS_BASE + boost;
    }

    function penaltyBpsForRemaining(uint256 remaining) public pure returns (uint256) {
        if (remaining == 0) return 0;
        return (MAX_PENALTY_BPS * remaining) / (remaining + HALF_LIFE_SECS);
    }

    function lock(uint256 shares, uint256 duration) external nonReentrant returns (uint256 positionId) {
        require(shares >= MIN_LOCK, "LockVaultV2: lock below minimum");
        uint256 fsBps = feeShareForDuration(duration);

        voo.safeTransferFrom(msg.sender, address(this), shares);

        uint256 weighted = (shares * fsBps) / BPS_BASE;

        // sweep to existing lockers before adding the new one — prevents new locker from claiming pre-join fees
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
            rewardDebt: (weighted * accRewardPerWeightedShare) / PRECISION,
            tier: ILockVault.Tier.FULL
        });

        // first-locker bootstrap: fees stranded while totalWeightedShares was 0 go to the first locker
        if (undistributedFees > 0) {
            uint256 fees = undistributedFees;
            undistributedFees = 0;
            accRewardPerWeightedShare += (fees * PRECISION) / totalWeightedShares;
            emit FeesDistributed(fees, accRewardPerWeightedShare);
        }

        emit Locked(positionId, msg.sender, shares, duration, fsBps, block.timestamp + duration);
    }

    /// @notice Extend a position; settles pending rewards at old weight first to prevent retroactive credit.
    function extend(uint256 positionId, uint256 additionalDuration) external nonReentrant {
        require(additionalDuration > 0, "LockVaultV2: zero extension");
        LockPosition storage pos = positions[positionId];
        require(pos.owner == msg.sender, "LockVaultV2: not owner");
        require(pos.shares > 0, "LockVaultV2: empty position");
        require(pos.tier == ILockVault.Tier.FULL, "LockVaultV2: FULL only");
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

    /// @notice Unlock after maturity. FULL=owner-only return; LEAST=permissionless burn-to-LP; PARTIAL=unreachable.
    function unlock(uint256 positionId) external nonReentrant {
        LockPosition storage pos = positions[positionId];
        require(pos.shares > 0, "LockVaultV2: empty position");
        require(block.timestamp >= pos.unlockAt, "LockVaultV2: still locked");

        ILockVault.Tier tier = pos.tier;
        uint256 shares = pos.shares;
        address owner = pos.owner;

        if (tier == ILockVault.Tier.FULL) {
            require(owner == msg.sender, "LockVaultV2: not owner");
            _settleRewards(positionId);
            _removePosition(positionId);
            voo.safeTransfer(msg.sender, shares);
            emit Unlocked(positionId, msg.sender, shares);
        } else if (tier == ILockVault.Tier.LEAST) {
            _removePosition(positionId);
            vault.burnFromLockVault(shares);
            emit LeastPrincipalBurned(positionId, owner, shares);
        } else {
            // PARTIAL: unreachable via normal flow (unlockAt == max)
            revert("LockVaultV2: PARTIAL cannot unlock");
        }
    }

    function earlyWithdraw(uint256 positionId) external nonReentrant {
        LockPosition storage pos = positions[positionId];
        require(pos.owner == msg.sender, "LockVaultV2: not owner");
        require(pos.shares > 0, "LockVaultV2: empty position");
        require(pos.tier == ILockVault.Tier.FULL, "LockVaultV2: FULL only");
        require(block.timestamp < pos.unlockAt, "LockVaultV2: already matured");

        uint256 shares = pos.shares;
        _settleRewards(positionId);

        uint256 remaining = pos.unlockAt - block.timestamp;
        uint256 pBps = penaltyBpsForRemaining(remaining);
        uint256 penaltyShares = (shares * pBps) / BPS_BASE;
        uint256 returned = shares - penaltyShares;

        _removePosition(positionId);

        voo.safeTransfer(msg.sender, returned);
        emit EarlyWithdraw(positionId, msg.sender, returned, penaltyShares);
    }

    /// @notice HouseVault-only. Rehab tiers earn no fees on principal. PARTIAL locks forever; LEAST burns at expiry.
    function rehabLock(
        address user,
        uint256 shares,
        uint256 duration,
        ILockVault.Tier tier
    ) external override onlyVault nonReentrant {
        require(user != address(0), "LockVaultV2: zero user");
        require(shares > 0, "LockVaultV2: zero shares");
        require(
            tier == ILockVault.Tier.PARTIAL || tier == ILockVault.Tier.LEAST,
            "LockVaultV2: invalid rehab tier"
        );

        voo.safeTransferFrom(msg.sender, address(this), shares);

        totalLockedShares += shares;

        uint256 unlockAt =
            tier == ILockVault.Tier.PARTIAL ? type(uint256).max : block.timestamp + duration;

        uint256 positionId = nextPositionId++;
        positions[positionId] = LockPosition({
            owner: user,
            shares: shares,
            duration: duration,
            lockedAt: block.timestamp,
            unlockAt: unlockAt,
            feeShareBps: 0,
            rewardDebt: 0,
            tier: tier
        });

        emit RehabLocked(positionId, user, tier, shares, duration, unlockAt);
    }

    /// @notice One-way PARTIAL→FULL promotion (re-lock ≥ MIN_GRADUATE_DURATION); grants FULL weight + a fresh-loss-sized promo credit.
    function graduate(uint256 positionId, uint256 newDuration) external nonReentrant {
        LockPosition storage pos = positions[positionId];
        require(pos.owner == msg.sender, "LockVaultV2: not owner");
        require(pos.shares > 0, "LockVaultV2: empty position");
        require(pos.tier == ILockVault.Tier.PARTIAL, "LockVaultV2: PARTIAL only");
        require(newDuration >= MIN_GRADUATE_DURATION, "LockVaultV2: graduate duration too short");

        uint256 newFsBps = feeShareForDuration(newDuration);
        uint256 newWeighted = (pos.shares * newFsBps) / BPS_BASE;

        // mirrors lock()'s ordering: sweep to existing FULLs before adding the graduate's weight
        if (undistributedFees > 0 && totalWeightedShares > 0) {
            uint256 fees = undistributedFees;
            undistributedFees = 0;
            accRewardPerWeightedShare += (fees * PRECISION) / totalWeightedShares;
            emit FeesDistributed(fees, accRewardPerWeightedShare);
        }

        totalWeightedShares += newWeighted;
        // totalLockedShares unchanged — shares stay locked, tier transitions

        pos.tier = ILockVault.Tier.FULL;
        pos.duration = newDuration;
        pos.lockedAt = block.timestamp;
        pos.unlockAt = block.timestamp + newDuration;
        pos.feeShareBps = newFsBps;
        pos.rewardDebt = (newWeighted * accRewardPerWeightedShare) / PRECISION;

        // first-locker bootstrap: stranded fees go to the graduate
        if (undistributedFees > 0) {
            uint256 fees = undistributedFees;
            undistributedFees = 0;
            accRewardPerWeightedShare += (fees * PRECISION) / totalWeightedShares;
            emit FeesDistributed(fees, accRewardPerWeightedShare);
        }

        uint256 principal = vault.convertToAssets(pos.shares);
        uint256 promoCredit = vault.creditFor(principal);
        if (promoCredit > 0) {
            vault.issuePromoCredit(pos.owner, promoCredit);
        }

        emit Graduated(positionId, pos.owner, newDuration, newFsBps, pos.unlockAt, promoCredit);
    }

    function settleRewards(uint256 positionId) external nonReentrant {
        LockPosition storage pos = positions[positionId];
        require(pos.owner == msg.sender, "LockVaultV2: not owner");
        require(pos.shares > 0, "LockVaultV2: empty position");
        uint256 pendingBefore = pendingRewards[msg.sender];
        _settleRewards(positionId);
        uint256 reward = pendingRewards[msg.sender] - pendingBefore;
        emit Harvested(positionId, msg.sender, reward);
    }

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

    function claimFees() external nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, "LockVaultV2: nothing to claim");

        pendingRewards[msg.sender] = 0;
        IERC20 usdc = vault.asset();
        usdc.safeTransfer(msg.sender, amount);

        emit RewardsClaimed(msg.sender, amount);
    }

    function sweepPenaltyShares(address receiver) external onlyOwner nonReentrant {
        require(receiver != address(0), "LockVaultV2: zero receiver");
        uint256 balance = voo.balanceOf(address(this));
        require(balance > totalLockedShares, "LockVaultV2: no penalty shares");
        uint256 penaltyShares = balance - totalLockedShares;
        voo.safeTransfer(receiver, penaltyShares);
        emit PenaltySharesSwept(receiver, penaltyShares);
    }

    function getPosition(uint256 positionId) external view returns (LockPosition memory) {
        return positions[positionId];
    }

    function pendingReward(uint256 positionId) external view returns (uint256) {
        LockPosition memory pos = positions[positionId];
        if (pos.shares == 0) return 0;
        uint256 weighted = (pos.shares * pos.feeShareBps) / BPS_BASE;
        return ((weighted * accRewardPerWeightedShare) / PRECISION) - pos.rewardDebt;
    }

    function currentPenaltyBps(uint256 positionId) external view returns (uint256) {
        LockPosition memory pos = positions[positionId];
        if (pos.shares == 0 || block.timestamp >= pos.unlockAt) return 0;
        return penaltyBpsForRemaining(pos.unlockAt - block.timestamp);
    }

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
