// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Owner-managed registry of betting legs. Each leg references an oracle adapter and a probability estimate.
contract LegRegistry is Ownable {
    struct Leg {
        string question;
        string sourceRef;
        uint256 cutoffTime;
        uint256 earliestResolve;
        address oracleAdapter;
        uint256 probabilityPPM;
        bool active;
    }

    mapping(uint256 => Leg) private _legs;
    uint256 private _legCount;

    address public engine;

    /// @notice keccak256(sourceRef) → legId+1. Stored offset by 1 so the (valid) legId 0 isn't ambiguous with "not created".
    mapping(bytes32 => uint256) private _legIdBySourceRefPlusOne;

    /// @notice legId → correlationGroupId. 0 = uncorrelated.
    mapping(uint256 => uint256) public legCorrGroup;

    /// @notice legId → exclusionGroupId. 0 = no exclusion.
    mapping(uint256 => uint256) public legExclusionGroup;

    event LegCreated(uint256 indexed legId, string question, uint256 cutoffTime, uint256 probabilityPPM);
    event ProbabilityUpdated(uint256 indexed legId, uint256 oldPPM, uint256 newPPM);
    event LegDeactivated(uint256 indexed legId);
    event EngineUpdated(address indexed oldEngine, address indexed newEngine);
    event LegCorrGroupSet(uint256 indexed legId, uint256 oldGroupId, uint256 newGroupId);
    event LegExclusionGroupSet(uint256 indexed legId, uint256 oldGroupId, uint256 newGroupId);

    constructor() Ownable(msg.sender) {}

    modifier onlyEngine() {
        require(msg.sender == engine, "LegRegistry: only engine");
        _;
    }

    function setEngine(address _engine) external onlyOwner {
        emit EngineUpdated(engine, _engine);
        engine = _engine;
    }

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

    /// @notice Resolve-or-create a leg by sourceRef. If already registered, returns existing legId and ignores passed metadata.
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

    function updateProbability(uint256 legId, uint256 newPPM) external onlyOwner {
        require(legId < _legCount, "LegRegistry: invalid legId");
        require(newPPM > 0 && newPPM <= 1e6, "LegRegistry: invalid probability");
        uint256 oldPPM = _legs[legId].probabilityPPM;
        _legs[legId].probabilityPPM = newPPM;
        emit ProbabilityUpdated(legId, oldPPM, newPPM);
    }

    function deactivateLeg(uint256 legId) external onlyOwner {
        require(legId < _legCount, "LegRegistry: invalid legId");
        _legs[legId].active = false;
        emit LegDeactivated(legId);
    }

    function getLeg(uint256 legId) external view returns (Leg memory) {
        require(legId < _legCount, "LegRegistry: invalid legId");
        return _legs[legId];
    }

    function legCount() external view returns (uint256) {
        return _legCount;
    }

    /// @notice (legId, true) if registered, (0, false) otherwise.
    function legIdBySourceRef(string calldata sourceRef) external view returns (uint256 legId, bool exists) {
        uint256 plus = _legIdBySourceRefPlusOne[keccak256(bytes(sourceRef))];
        if (plus == 0) return (0, false);
        return (plus - 1, true);
    }

    /// @notice 0 = uncorrelated.
    function setLegCorrGroup(uint256 legId, uint256 groupId) external onlyOwner {
        require(legId < _legCount, "LegRegistry: invalid legId");
        uint256 oldGroup = legCorrGroup[legId];
        legCorrGroup[legId] = groupId;
        emit LegCorrGroupSet(legId, oldGroup, groupId);
    }

    /// @notice 0 = no exclusion.
    function setLegExclusionGroup(uint256 legId, uint256 groupId) external onlyOwner {
        require(legId < _legCount, "LegRegistry: invalid legId");
        uint256 oldGroup = legExclusionGroup[legId];
        legExclusionGroup[legId] = groupId;
        emit LegExclusionGroupSet(legId, oldGroup, groupId);
    }

    function getLegCorrGroups(uint256[] calldata legIds) external view returns (uint256[] memory groups) {
        groups = new uint256[](legIds.length);
        for (uint256 i = 0; i < legIds.length; i++) {
            groups[i] = legCorrGroup[legIds[i]];
        }
    }

    function getLegExclusionGroups(uint256[] calldata legIds) external view returns (uint256[] memory groups) {
        groups = new uint256[](legIds.length);
        for (uint256 i = 0; i < legIds.length; i++) {
            groups[i] = legExclusionGroup[legIds[i]];
        }
    }
}
