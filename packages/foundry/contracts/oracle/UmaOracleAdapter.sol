// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOracleAdapter, LegStatus} from "../interfaces/IOracleAdapter.sol";
import {IOptimisticOracleV3, IOptimisticOracleV3CallbackRecipient} from "../interfaces/IOptimisticOracleV3.sol";

/// @title UmaOracleAdapter
/// @notice Trustless oracle adapter backed by UMA Optimistic Oracle V3. Anyone can
///         assert a leg outcome by posting a bond; undisputed assertions settle
///         truthful after the liveness window; disputes escalate to UMA's DVM.
///
/// @dev No `onlyOwner` function can mutate finalized outcome state. The only writer
///      to `_finalStatus` / `_finalOutcome` / `_isFinalized` is the UMA callback,
///      gated by `msg.sender == address(uma)`. This is the F-5 property that
///      removes the admin backdoor from the mainnet oracle path.
contract UmaOracleAdapter is IOracleAdapter, IOptimisticOracleV3CallbackRecipient, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Immutable UMA wiring ─────────────────────────────────────────────

    IOptimisticOracleV3 public immutable uma;
    IERC20 public immutable bondToken;
    bytes32 public immutable identifier;
    uint256 public immutable minBond;

    // ── Tunable ──────────────────────────────────────────────────────────

    uint64 public liveness;
    uint256 public bondAmount;

    // ── Leg ↔ assertion ─────────────────────────────────────────────────

    mapping(uint256 legId => bytes32 assertionId) public assertionByLeg;
    mapping(bytes32 assertionId => uint256 legId) public legByAssertion;

    // ── Finalized outcome state (only UMA callback writes these) ────────

    mapping(uint256 legId => LegStatus) private _finalStatus;
    mapping(uint256 legId => bytes32) private _finalOutcome;
    mapping(uint256 legId => bool) private _isFinalized;

    // ── Pending (per-assertion) state ───────────────────────────────────

    mapping(bytes32 assertionId => LegStatus) private _pendingStatus;
    mapping(bytes32 assertionId => bytes32) private _pendingOutcome;

    // ── Events ───────────────────────────────────────────────────────────

    event AssertionCreated(
        uint256 indexed legId, bytes32 indexed assertionId, LegStatus status, bytes32 outcome, address indexed asserter
    );
    event AssertionResolved(uint256 indexed legId, bytes32 indexed assertionId, LegStatus status, bytes32 outcome);
    event AssertionRejected(uint256 indexed legId, bytes32 indexed assertionId);
    event AssertionDisputed(uint256 indexed legId, bytes32 indexed assertionId);
    event LivenessSet(uint64 liveness);
    event BondAmountSet(uint256 bondAmount);

    // ── Errors ───────────────────────────────────────────────────────────

    error UmaOracle__AlreadyFinalized();
    error UmaOracle__PendingAssertion();
    error UmaOracle__InvalidStatus();
    error UmaOracle__NotUma();
    error UmaOracle__BondBelowMin();
    error UmaOracle__UnknownAssertion();

    // ── Constructor ──────────────────────────────────────────────────────

    constructor(IOptimisticOracleV3 _uma, IERC20 _bondToken, uint64 _liveness, uint256 _bondAmount)
        Ownable(msg.sender)
    {
        uma = _uma;
        bondToken = _bondToken;
        identifier = _uma.defaultIdentifier();
        minBond = _uma.getMinimumBond(address(_bondToken));

        if (_bondAmount < minBond) revert UmaOracle__BondBelowMin();
        liveness = _liveness;
        bondAmount = _bondAmount;
    }

    // ── Admin (config only — cannot alter outcomes) ──────────────────────

    function setLiveness(uint64 _liveness) external onlyOwner {
        liveness = _liveness;
        emit LivenessSet(_liveness);
    }

    function setBondAmount(uint256 _bondAmount) external onlyOwner {
        if (_bondAmount < minBond) revert UmaOracle__BondBelowMin();
        bondAmount = _bondAmount;
        emit BondAmountSet(_bondAmount);
    }

    // ── Assert ───────────────────────────────────────────────────────────

    /// @notice Assert an outcome for a leg. Permissionless — anyone can call by
    ///         posting `bondAmount` of `bondToken`. The bond is refunded on a
    ///         truthful settlement (minus UMA's final fee), or slashed on dispute.
    /// @param legId      ParlayVoo leg id (registered in LegRegistry).
    /// @param status     Proposed LegStatus. Must not be `Unresolved`.
    /// @param outcome    Proposed outcome hash (same semantics as AdminOracleAdapter).
    /// @param claim      UTF-8 human-readable claim. Built off-chain; forwarded to UMA.
    function assertOutcome(uint256 legId, LegStatus status, bytes32 outcome, bytes calldata claim)
        external
        nonReentrant
        returns (bytes32 assertionId)
    {
        if (_isFinalized[legId]) revert UmaOracle__AlreadyFinalized();
        if (assertionByLeg[legId] != bytes32(0)) revert UmaOracle__PendingAssertion();
        if (status == LegStatus.Unresolved) revert UmaOracle__InvalidStatus();

        uint256 _bond = bondAmount;
        bondToken.safeTransferFrom(msg.sender, address(this), _bond);
        bondToken.forceApprove(address(uma), _bond);

        assertionId = uma.assertTruth(
            claim, msg.sender, address(this), address(0), liveness, bondToken, _bond, identifier, bytes32(0)
        );

        assertionByLeg[legId] = assertionId;
        legByAssertion[assertionId] = legId;
        _pendingStatus[assertionId] = status;
        _pendingOutcome[assertionId] = outcome;

        emit AssertionCreated(legId, assertionId, status, outcome, msg.sender);
    }

    /// @notice Convenience wrapper: settle an assertion that has passed liveness.
    ///         Callable by anyone; reverts pre-liveness or pre-dispute-resolution
    ///         (the underlying UMA revert propagates).
    /// @param legId ParlayVoo leg id with a pending assertion.
    function settleMature(uint256 legId) external {
        bytes32 assertionId = assertionByLeg[legId];
        if (assertionId == bytes32(0)) revert UmaOracle__UnknownAssertion();
        uma.settleAssertion(assertionId);
    }

    // ── UMA callbacks ────────────────────────────────────────────────────

    /// @inheritdoc IOptimisticOracleV3CallbackRecipient
    function assertionResolvedCallback(bytes32 assertionId, bool assertedTruthfully) external {
        if (msg.sender != address(uma)) revert UmaOracle__NotUma();

        uint256 legId = legByAssertion[assertionId];
        if (assertedTruthfully) {
            LegStatus status = _pendingStatus[assertionId];
            bytes32 outcome = _pendingOutcome[assertionId];
            _finalStatus[legId] = status;
            _finalOutcome[legId] = outcome;
            _isFinalized[legId] = true;
            emit AssertionResolved(legId, assertionId, status, outcome);
        } else {
            delete assertionByLeg[legId];
            emit AssertionRejected(legId, assertionId);
        }
        delete _pendingStatus[assertionId];
        delete _pendingOutcome[assertionId];
        delete legByAssertion[assertionId];
    }

    /// @inheritdoc IOptimisticOracleV3CallbackRecipient
    function assertionDisputedCallback(bytes32 assertionId) external {
        emit AssertionDisputed(legByAssertion[assertionId], assertionId);
    }

    // ── IOracleAdapter ───────────────────────────────────────────────────

    /// @inheritdoc IOracleAdapter
    function getStatus(uint256 legId) external view override returns (LegStatus status, bytes32 outcome) {
        if (!_isFinalized[legId]) return (LegStatus.Unresolved, bytes32(0));
        return (_finalStatus[legId], _finalOutcome[legId]);
    }

    /// @inheritdoc IOracleAdapter
    function canResolve(uint256 legId) external view override returns (bool) {
        return _isFinalized[legId];
    }
}
