// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOracleAdapter, LegStatus} from "../interfaces/IOracleAdapter.sol";
import {
    IOptimisticOracleV3,
    IOptimisticOracleV3CallbackRecipient
} from "../interfaces/IOptimisticOracleV3.sol";

/// @notice UMA OOv3-backed trustless oracle: anyone asserts (with bond), undisputed settles after liveness, disputes escalate to DVM.
/// @dev F-5: no owner path mutates finalized outcome state. Only the UMA callback (gated on msg.sender == uma) writes `_finalStatus`/`_finalOutcome`/`_isFinalized`.
contract UmaOracleAdapter is IOracleAdapter, IOptimisticOracleV3CallbackRecipient, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IOptimisticOracleV3 public immutable uma;
    IERC20 public immutable bondToken;
    bytes32 public immutable identifier;
    uint256 public immutable minBond;

    uint64 public liveness;
    uint256 public bondAmount;

    mapping(uint256 legId => bytes32 assertionId) public assertionByLeg;
    mapping(bytes32 assertionId => uint256 legId) public legByAssertion;

    // only UMA callback writes the finalized state below
    mapping(uint256 legId => LegStatus) private _finalStatus;
    mapping(uint256 legId => bytes32) private _finalOutcome;
    mapping(uint256 legId => bool) private _isFinalized;

    mapping(bytes32 assertionId => LegStatus) private _pendingStatus;
    mapping(bytes32 assertionId => bytes32) private _pendingOutcome;

    event AssertionCreated(
        uint256 indexed legId,
        bytes32 indexed assertionId,
        LegStatus status,
        bytes32 outcome,
        address indexed asserter
    );
    event AssertionResolved(uint256 indexed legId, bytes32 indexed assertionId, LegStatus status, bytes32 outcome);
    event AssertionRejected(uint256 indexed legId, bytes32 indexed assertionId);
    event AssertionDisputed(uint256 indexed legId, bytes32 indexed assertionId);
    event LivenessSet(uint64 liveness);
    event BondAmountSet(uint256 bondAmount);

    error UmaOracle__AlreadyFinalized();
    error UmaOracle__PendingAssertion();
    error UmaOracle__InvalidStatus();
    error UmaOracle__NotUma();
    error UmaOracle__BondBelowMin();
    error UmaOracle__UnknownAssertion();

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

    // owner can tune liveness/bondAmount but cannot mutate outcomes (see F-5 above)

    function setLiveness(uint64 _liveness) external onlyOwner {
        liveness = _liveness;
        emit LivenessSet(_liveness);
    }

    function setBondAmount(uint256 _bondAmount) external onlyOwner {
        if (_bondAmount < minBond) revert UmaOracle__BondBelowMin();
        bondAmount = _bondAmount;
        emit BondAmountSet(_bondAmount);
    }

    /// @notice Permissionless. Caller posts bondAmount; refunded on truthful settlement, slashed on dispute.
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
            claim,
            msg.sender,
            address(this),
            address(0),
            liveness,
            bondToken,
            _bond,
            identifier,
            bytes32(0)
        );

        assertionByLeg[legId] = assertionId;
        legByAssertion[assertionId] = legId;
        _pendingStatus[assertionId] = status;
        _pendingOutcome[assertionId] = outcome;

        emit AssertionCreated(legId, assertionId, status, outcome, msg.sender);
    }

    /// @notice Permissionless. Underlying UMA revert propagates pre-liveness or pre-dispute-resolution.
    function settleMature(uint256 legId) external {
        bytes32 assertionId = assertionByLeg[legId];
        if (assertionId == bytes32(0)) revert UmaOracle__UnknownAssertion();
        uma.settleAssertion(assertionId);
    }

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
