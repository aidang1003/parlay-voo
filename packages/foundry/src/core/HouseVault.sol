// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";
import {ILockVault} from "../interfaces/ILockVault.sol";

/// @notice ERC4626-like vault holding USDC for the ParlayCity house. LPs deposit USDC and receive VOO shares.
contract HouseVault is ERC20, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;

    /// @notice Total USDC reserved as exposure for active tickets.
    uint256 public totalReserved;

    /// @notice Max fraction of TVL that can be reserved (basis points). Default 80%.
    uint256 public maxUtilizationBps;

    /// @notice Max payout for a single ticket as fraction of TVL (bps). Default 5%.
    uint256 public maxPayoutBps;

    /// @notice Address of the ParlayEngine authorized to reserve/release/pay.
    address public engine;

    /// @notice LockVault for routing fee income to lockers.
    ILockVault public lockVault;

    /// @notice Safety module address for routing fee income to insurance buffer.
    address public safetyModule;

    /// @notice Optional yield adapter for deploying idle capital.
    IYieldAdapter public yieldAdapter;

    /// @notice Minimum local buffer as fraction of totalAssets (bps). Default 25%.
    uint256 public yieldBufferBps = 2500;

    /// @notice Minimum deposit amount (1 USDC). Mitigates first-depositor inflation attack.
    uint256 public constant MIN_DEPOSIT = 1e6;

    /// @notice Projected 12-month APR used to size rehab credits (basis points). Default 6%.
    uint256 public projectedAprBps = 600;

    /// @notice Bet-only credit balance issued to users who lost parlays and entered rehab.
    mapping(address => uint256) public creditBalance;

    /// @notice Sub-threshold losses stay with LPs as implicit profit (gas cost > redeem value).
    uint256 public constant MIN_REHAB_STAKE = 1e6;

    uint256 public constant MIN_REHAB_DURATION = 365 days;

    mapping(address => uint256) public rehabClaimable;

    /// @notice Subtracted from totalAssets() so LP share price stays flat between loss and claim.
    uint256 public totalRehabClaimable;

    /// @notice Correlation pricing knobs. See docs/changes/B_SLOG_SPRINT.md.
    struct CorrelationConfig {
        uint256 corrAsymptoteBps;
        uint256 corrHalfSatPpm;
        uint256 maxLegsPerGroup;
    }

    CorrelationConfig public corrConfig;

    event Deposited(address indexed depositor, address indexed receiver, uint256 assets, uint256 shares);
    event Withdrawn(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event PayoutReserved(uint256 amount, uint256 newTotalReserved);
    event PayoutReleased(uint256 amount, uint256 newTotalReserved);
    event WinnerPaid(address indexed winner, uint256 amount);
    event VoidedRefund(address indexed user, uint256 amount);
    event EngineSet(address indexed engine);
    event MaxUtilizationBpsSet(uint256 bps);
    event MaxPayoutBpsSet(uint256 bps);
    event YieldAdapterSet(address indexed adapter);
    event YieldBufferBpsSet(uint256 bps);
    event IdleDeployed(uint256 amount);
    event RecalledFromAdapter(uint256 amount);
    event LockVaultSet(address indexed lockVault);
    event SafetyModuleSet(address indexed safetyModule);
    event FeesRouted(uint256 feeToLockers, uint256 feeToSafety, uint256 feeToVault);
    event ProjectedAprChanged(uint256 oldBps, uint256 newBps);
    event CreditIssued(address indexed user, uint256 amount);
    event CreditSpent(address indexed user, uint256 amount);
    event RehabLossAccrued(address indexed loser, uint256 stake, uint256 newClaimable);
    event RehabClaimed(
        address indexed user, uint256 stake, uint256 shares, uint256 duration, uint256 creditIssued
    );
    event LeastPrincipalBurned(uint256 shares);
    event LosslessWinRouted(address indexed owner, uint256 payout, uint256 sharesMinted);
    event PromoCreditIssued(address indexed user, uint256 amount);
    event CorrAsymptoteBpsSet(uint256 oldBps, uint256 newBps);
    event CorrHalfSatPpmSet(uint256 oldPpm, uint256 newPpm);
    event MaxLegsPerGroupSet(uint256 oldN, uint256 newN);

    modifier onlyEngine() {
        require(msg.sender == engine, "HouseVault: caller is not engine");
        _;
    }

    constructor(
        IERC20 _asset,
        uint256 _corrAsymptoteBps,
        uint256 _corrHalfSatPpm,
        uint256 _maxLegsPerGroup
    ) ERC20("ParlayVoo", "VOO") Ownable(msg.sender) {
        require(_corrAsymptoteBps <= 10_000, "HouseVault: invalid corr asymptote");
        require(_maxLegsPerGroup > 0, "HouseVault: zero maxLegsPerGroup");
        asset = _asset;
        maxUtilizationBps = 8000;
        maxPayoutBps = 500;
        corrConfig = CorrelationConfig({
            corrAsymptoteBps: _corrAsymptoteBps,
            corrHalfSatPpm: _corrHalfSatPpm,
            maxLegsPerGroup: _maxLegsPerGroup
        });
    }

    function setEngine(address _engine) external onlyOwner {
        require(_engine != address(0), "HouseVault: zero address");
        engine = _engine;
        emit EngineSet(_engine);
    }

    function setMaxUtilizationBps(uint256 _bps) external onlyOwner {
        require(_bps <= 10_000, "HouseVault: invalid bps");
        maxUtilizationBps = _bps;
        emit MaxUtilizationBpsSet(_bps);
    }

    function setMaxPayoutBps(uint256 _bps) external onlyOwner {
        require(_bps <= 10_000, "HouseVault: invalid bps");
        maxPayoutBps = _bps;
        emit MaxPayoutBpsSet(_bps);
    }

    function setLockVault(ILockVault _lockVault) external onlyOwner {
        require(address(_lockVault) != address(0), "HouseVault: zero address");
        lockVault = _lockVault;
        emit LockVaultSet(address(_lockVault));
    }

    function setSafetyModule(address _safetyModule) external onlyOwner {
        require(_safetyModule != address(0), "HouseVault: zero address");
        safetyModule = _safetyModule;
        emit SafetyModuleSet(_safetyModule);
    }

    function setYieldAdapter(IYieldAdapter _adapter) external onlyOwner {
        yieldAdapter = _adapter;
        emit YieldAdapterSet(address(_adapter));
    }

    function setYieldBufferBps(uint256 _bps) external onlyOwner {
        require(_bps <= 10_000, "HouseVault: invalid buffer bps");
        yieldBufferBps = _bps;
        emit YieldBufferBpsSet(_bps);
    }

    function setProjectedAprBps(uint256 _bps) external onlyOwner {
        require(_bps <= 10_000, "HouseVault: invalid apr bps");
        uint256 old = projectedAprBps;
        projectedAprBps = _bps;
        emit ProjectedAprChanged(old, _bps);
    }

    function setCorrAsymptoteBps(uint256 bps) external onlyOwner {
        require(bps <= 10_000, "HouseVault: invalid corr asymptote");
        uint256 old = corrConfig.corrAsymptoteBps;
        corrConfig.corrAsymptoteBps = bps;
        emit CorrAsymptoteBpsSet(old, bps);
    }

    function setCorrHalfSatPpm(uint256 ppm) external onlyOwner {
        require(ppm > 0, "HouseVault: zero halfSatPpm");
        uint256 old = corrConfig.corrHalfSatPpm;
        corrConfig.corrHalfSatPpm = ppm;
        emit CorrHalfSatPpmSet(old, ppm);
    }

    function setMaxLegsPerGroup(uint256 n) external onlyOwner {
        require(n > 0, "HouseVault: zero maxLegsPerGroup");
        uint256 old = corrConfig.maxLegsPerGroup;
        corrConfig.maxLegsPerGroup = n;
        emit MaxLegsPerGroupSet(old, n);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Total managed USDC (local + adapter), excluding earmarked rehab claims so LP share price stays flat across a loss.
    function totalAssets() public view returns (uint256) {
        uint256 local = asset.balanceOf(address(this));
        uint256 gross = address(yieldAdapter) != address(0) ? local + yieldAdapter.balance() : local;
        return gross > totalRehabClaimable ? gross - totalRehabClaimable : 0;
    }

    function localBalance() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// @notice Free liquidity available for new reservations/withdrawals; only counts local (reserved needs instant availability).
    function freeLiquidity() public view returns (uint256) {
        uint256 local = localBalance();
        return local > totalReserved ? local - totalReserved : 0;
    }

    function safeDeployable() public view returns (uint256) {
        uint256 local = localBalance();
        uint256 minLocal = (totalAssets() * yieldBufferBps) / 10_000;
        if (totalReserved > minLocal) minLocal = totalReserved;
        return local > minLocal ? local - minLocal : 0;
    }

    function maxPayout() public view returns (uint256) {
        return (totalAssets() * maxPayoutBps) / 10_000;
    }

    function maxReservable() public view returns (uint256) {
        return (totalAssets() * maxUtilizationBps) / 10_000;
    }

    /// @notice Convert assets to shares. +1 virtual offset mitigates inflation attack.
    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply();
        uint256 total = totalAssets();
        if (supply == 0 || total == 0) return assets;
        return (assets * (supply + 1)) / (total + 1);
    }

    /// @notice Convert shares to assets. +1 virtual offset mitigates inflation attack.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply();
        uint256 total = totalAssets();
        if (supply == 0 || total == 0) return shares;
        return (shares * (total + 1)) / (supply + 1);
    }

    function deposit(uint256 assets, address receiver) external nonReentrant whenNotPaused returns (uint256 shares) {
        require(assets >= MIN_DEPOSIT, "HouseVault: deposit below minimum");
        require(receiver != address(0), "HouseVault: zero receiver");

        shares = convertToShares(assets);
        require(shares > 0, "HouseVault: zero shares");

        asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);

        emit Deposited(msg.sender, receiver, assets, shares);
    }

    /// @notice Burn VOO and withdraw USDC. Capped to free liquidity.
    function withdraw(uint256 shares, address receiver) external nonReentrant whenNotPaused returns (uint256 assets) {
        require(shares > 0, "HouseVault: zero shares");
        require(receiver != address(0), "HouseVault: zero receiver");

        assets = convertToAssets(shares);
        require(assets > 0, "HouseVault: zero assets");
        require(assets <= freeLiquidity(), "HouseVault: insufficient free liquidity");

        _burn(msg.sender, shares);
        asset.safeTransfer(receiver, assets);

        emit Withdrawn(msg.sender, receiver, assets, shares);
    }

    function reservePayout(uint256 amount) external onlyEngine nonReentrant {
        require(totalReserved + amount <= maxReservable(), "HouseVault: utilization cap exceeded");
        require(amount <= maxPayout(), "HouseVault: exceeds max payout");
        require(amount <= freeLiquidity(), "HouseVault: insufficient free liquidity");
        totalReserved += amount;
        emit PayoutReserved(amount, totalReserved);
    }

    function releasePayout(uint256 amount) external onlyEngine nonReentrant {
        require(amount <= totalReserved, "HouseVault: release exceeds reserved");
        totalReserved -= amount;
        emit PayoutReleased(amount, totalReserved);
    }

    function payWinner(address winner, uint256 amount) external onlyEngine nonReentrant {
        require(amount <= totalReserved, "HouseVault: pay exceeds reserved");
        totalReserved -= amount;
        asset.safeTransfer(winner, amount);
        emit WinnerPaid(winner, amount);
    }

    function refundVoided(address user, uint256 amount) external onlyEngine nonReentrant {
        asset.safeTransfer(user, amount);
        emit VoidedRefund(user, amount);
    }

    /// @notice Route fee portions out to LockVault and SafetyModule. feeToVault stays implicit.
    function routeFees(uint256 feeToLockers, uint256 feeToSafety, uint256 feeToVault)
        external
        onlyEngine
        nonReentrant
    {
        require(address(lockVault) != address(0), "HouseVault: lockVault not configured");
        require(safetyModule != address(0), "HouseVault: safetyModule not configured");

        uint256 totalOut = feeToLockers + feeToSafety;
        require(freeLiquidity() >= totalOut, "HouseVault: insufficient free liquidity for routing");

        if (feeToLockers > 0) {
            asset.safeTransfer(address(lockVault), feeToLockers);
            lockVault.notifyFees(feeToLockers);
        }

        if (feeToSafety > 0) {
            asset.safeTransfer(safetyModule, feeToSafety);
        }

        emit FeesRouted(feeToLockers, feeToSafety, feeToVault);
    }

    function deployIdle(uint256 amount) external onlyOwner nonReentrant {
        require(address(yieldAdapter) != address(0), "HouseVault: no adapter");
        require(amount > 0, "HouseVault: zero amount");
        require(amount <= safeDeployable(), "HouseVault: exceeds safe deployable");

        asset.forceApprove(address(yieldAdapter), amount);
        yieldAdapter.deploy(amount);
        emit IdleDeployed(amount);
    }

    function recallFromAdapter(uint256 amount) external onlyOwner nonReentrant {
        require(address(yieldAdapter) != address(0), "HouseVault: no adapter");
        require(amount > 0, "HouseVault: zero amount");
        yieldAdapter.withdraw(amount);
        emit RecalledFromAdapter(amount);
    }

    function emergencyRecall() external onlyOwner nonReentrant {
        require(address(yieldAdapter) != address(0), "HouseVault: no adapter");
        yieldAdapter.emergencyWithdraw();
    }

    // see docs/REHAB_MODE.md for the credit model

    function _issueCredit(address user, uint256 amount) internal {
        if (amount == 0) return;
        creditBalance[user] += amount;
        emit CreditIssued(user, amount);
    }

    function _spendCredit(address user, uint256 amount) internal {
        require(creditBalance[user] >= amount, "HouseVault: insufficient credit");
        creditBalance[user] -= amount;
        emit CreditSpent(user, amount);
    }

    function creditFor(uint256 principal) public view returns (uint256) {
        return (principal * projectedAprBps) / 10_000;
    }

    /// @notice Accrue losing stake to loser's rehab balance. User claims later via claimRehab. Degrades gracefully if lockVault unset.
    function distributeLoss(uint256 stake, address loser) external onlyEngine nonReentrant {
        if (address(lockVault) == address(0)) return;
        if (stake < MIN_REHAB_STAKE) return;
        require(loser != address(0), "HouseVault: zero loser");

        rehabClaimable[loser] += stake;
        totalRehabClaimable += stake;

        emit RehabLossAccrued(loser, stake, rehabClaimable[loser]);
    }

    /// @notice Convert caller's rehab balance into a LEAST lock and issue projected-APR credit on the full balance.
    function claimRehab(uint256 duration) external nonReentrant returns (uint256 shares, uint256 credit) {
        require(address(lockVault) != address(0), "HouseVault: lockVault not configured");
        require(duration >= MIN_REHAB_DURATION, "HouseVault: duration too short");

        uint256 amount = rehabClaimable[msg.sender];
        require(amount > 0, "HouseVault: nothing to claim");

        // Price at pre-claim (stake still carved out), then un-carve and mint — keeps LP price neutral across claim.
        shares = convertToShares(amount);
        require(shares > 0, "HouseVault: zero shares");

        rehabClaimable[msg.sender] = 0;
        totalRehabClaimable -= amount;

        _mint(address(this), shares);
        _approve(address(this), address(lockVault), shares);
        lockVault.rehabLock(msg.sender, shares, duration, ILockVault.Tier.LEAST);

        credit = creditFor(amount);
        _issueCredit(msg.sender, credit);

        emit RehabClaimed(msg.sender, amount, shares, duration, credit);
    }

    /// @notice Burn lockVault VOO when a LEAST position expires; principal retires back to LPs.
    function burnFromLockVault(uint256 shares) external nonReentrant {
        require(msg.sender == address(lockVault), "HouseVault: not lockVault");
        require(shares > 0, "HouseVault: zero shares");
        _burn(address(lockVault), shares);
        emit LeastPrincipalBurned(shares);
    }

    function spendCredit(address user, uint256 amount) external onlyEngine {
        _spendCredit(user, amount);
    }

    function refundCredit(address user, uint256 amount) external onlyEngine {
        _issueCredit(user, amount);
    }

    /// @notice Issue promo credit on PARTIAL → FULL graduation. Only callable by lockVault.
    function issuePromoCredit(address user, uint256 amount) external nonReentrant {
        require(msg.sender == address(lockVault), "HouseVault: not lockVault");
        _issueCredit(user, amount);
        emit PromoCreditIssued(user, amount);
    }

    /// @notice Convert lossless-parlay win into a PARTIAL lock; reserved USDC stays as backing.
    function routeLosslessWin(address winner, uint256 payout) external onlyEngine nonReentrant {
        require(address(lockVault) != address(0), "HouseVault: lockVault not configured");
        require(winner != address(0), "HouseVault: zero winner");
        require(payout > 0, "HouseVault: zero payout");
        require(payout <= totalReserved, "HouseVault: payout exceeds reserved");

        uint256 shares = convertToShares(payout);
        require(shares > 0, "HouseVault: zero shares");

        totalReserved -= payout;

        _mint(address(this), shares);
        _approve(address(this), address(lockVault), shares);
        lockVault.rehabLock(winner, shares, MIN_REHAB_DURATION, ILockVault.Tier.PARTIAL);

        emit LosslessWinRouted(winner, payout, shares);
    }
}
