// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title LegRegistry
/// @notice Owner-managed registry of betting legs (individual outcomes that
///         can be combined into parlays). Each leg references an oracle adapter
///         and carries its own probability estimate.
contract LegRegistry is Ownable {
    // ── Types ────────────────────────────────────────────────────────────

    struct Leg {
        string question;
        string sourceRef;
        uint256 cutoffTime;
        uint256 earliestResolve;
        address oracleAdapter;
        uint256 probabilityPPM; // probability * 1e6
        bool active;
    }

    // ── State ────────────────────────────────────────────────────────────

    mapping(uint256 => Leg) private _legs;
    uint256 private _legCount;

    /// @notice Engine address authorized to create legs just-in-time via
    ///         `getOrCreateBySourceRef`. Owner-settable after deploy so that
    ///         LegRegistry can be deployed before ParlayEngine in the wiring.
    address public engine;

    /// @notice Dedupe index so multiple tickets referencing the same underlying
    ///         market (e.g. the same Polymarket conditionId) resolve to a
    ///         single on-chain Leg row and therefore share oracle resolution.
    ///         Keyed by keccak256(sourceRef); 0 means "not yet created" (and
    ///         legId 0 is a valid id, so callers must check existence by
    ///         re-reading `_legs[id].cutoffTime != 0` or equivalent — we
    ///         sidestep that ambiguity by storing legId + 1 and subtracting
    ///         on read).
    mapping(bytes32 => uint256) private _legIdBySourceRefPlusOne;

    // ── Events ───────────────────────────────────────────────────────────

    event LegCreated(uint256 indexed legId, string question, uint256 cutoffTime, uint256 probabilityPPM);
    event ProbabilityUpdated(uint256 indexed legId, uint256 oldPPM, uint256 newPPM);
    event LegDeactivated(uint256 indexed legId);
    event EngineUpdated(address indexed oldEngine, address indexed newEngine);

    // ── Constructor ──────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {}

    // ── Access ───────────────────────────────────────────────────────────

    modifier onlyEngine() {
        require(msg.sender == engine, "LegRegistry: only engine");
        _;
    }

    /// @notice Owner-set authorized engine for JIT leg creation.
    function setEngine(address _engine) external onlyOwner {
        emit EngineUpdated(engine, _engine);
        engine = _engine;
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /// @notice Create a new betting leg.
    function createLeg(
        string calldata question,
        string calldata sourceRef,
        uint256 cutoffTime,
        uint256 earliestResolve,
        address oracleAdapter,
        uint256 probabilityPPM
    ) external onlyOwner returns (uint256 legId) {
        require(oracleAdapter != address(0), "LegRegistry: zero oracle");
        require(probabilityPPM > 0 && probabilityPPM <= 1e6, "LegRegistry: invalid probability");
        require(cutoffTime > block.timestamp, "LegRegistry: cutoff in past");
        require(earliestResolve >= cutoffTime, "LegRegistry: resolve before cutoff");

        legId = _legCount++;
        _legs[legId] = Leg({
            question: question,
            sourceRef: sourceRef,
            cutoffTime: cutoffTime,
            earliestResolve: earliestResolve,
            oracleAdapter: oracleAdapter,
            probabilityPPM: probabilityPPM,
            active: true
        });
        _legIdBySourceRefPlusOne[keccak256(bytes(sourceRef))] = legId + 1;

        emit LegCreated(legId, question, cutoffTime, probabilityPPM);
    }

    /// @notice Resolve-or-create a leg by its stable sourceRef. Called by the
    ///         engine at ticket-buy time so tickets referencing the same
    ///         underlying market share a single Leg row (and therefore one
    ///         oracle resolution). If the sourceRef was already registered
    ///         the existing legId is returned and the passed metadata is
    ///         ignored — the original leg's cutoff / oracle / probability
    ///         stand. Only the engine may call this; the engine is expected
    ///         to have already verified a trusted signed quote before
    ///         reaching here, so metadata validation is minimal.
    function getOrCreateBySourceRef(
        string calldata question,
        string calldata sourceRef,
        uint256 cutoffTime,
        uint256 earliestResolve,
        address oracleAdapter,
        uint256 probabilityPPM
    ) external onlyEngine returns (uint256 legId) {
        bytes32 key = keccak256(bytes(sourceRef));
        uint256 existing = _legIdBySourceRefPlusOne[key];
        if (existing != 0) {
            return existing - 1;
        }

        require(oracleAdapter != address(0), "LegRegistry: zero oracle");
        require(probabilityPPM > 0 && probabilityPPM <= 1e6, "LegRegistry: invalid probability");
        require(cutoffTime > block.timestamp, "LegRegistry: cutoff in past");
        require(earliestResolve >= cutoffTime, "LegRegistry: resolve before cutoff");

        legId = _legCount++;
        _legs[legId] = Leg({
            question: question,
            sourceRef: sourceRef,
            cutoffTime: cutoffTime,
            earliestResolve: earliestResolve,
            oracleAdapter: oracleAdapter,
            probabilityPPM: probabilityPPM,
            active: true
        });
        _legIdBySourceRefPlusOne[key] = legId + 1;

        emit LegCreated(legId, question, cutoffTime, probabilityPPM);
    }

    /// @notice Update the implied probability of a leg.
    function updateProbability(uint256 legId, uint256 newPPM) external onlyOwner {
        require(legId < _legCount, "LegRegistry: invalid legId");
        require(newPPM > 0 && newPPM <= 1e6, "LegRegistry: invalid probability");
        uint256 oldPPM = _legs[legId].probabilityPPM;
        _legs[legId].probabilityPPM = newPPM;
        emit ProbabilityUpdated(legId, oldPPM, newPPM);
    }

    /// @notice Deactivate a leg so it can no longer be included in new parlays.
    function deactivateLeg(uint256 legId) external onlyOwner {
        require(legId < _legCount, "LegRegistry: invalid legId");
        _legs[legId].active = false;
        emit LegDeactivated(legId);
    }

    // ── Views ────────────────────────────────────────────────────────────

    function getLeg(uint256 legId) external view returns (Leg memory) {
        require(legId < _legCount, "LegRegistry: invalid legId");
        return _legs[legId];
    }

    function legCount() external view returns (uint256) {
        return _legCount;
    }

    /// @notice Look up a legId by sourceRef. Returns (legId, true) if the
    ///         sourceRef has been registered, (0, false) otherwise.
    function legIdBySourceRef(string calldata sourceRef) external view returns (uint256 legId, bool exists) {
        uint256 plus = _legIdBySourceRefPlusOne[keccak256(bytes(sourceRef))];
        if (plus == 0) return (0, false);
        return (plus - 1, true);
    }
}
