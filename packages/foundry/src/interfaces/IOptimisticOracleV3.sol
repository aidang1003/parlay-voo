// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Subset of UMA OOv3 we call. Local copy avoids pulling UMA's AGPL package. Upstream: UMAprotocol/protocol .../OptimisticOracleV3Interface.sol
interface IOptimisticOracleV3 {
    function assertTruth(
        bytes memory claim,
        address asserter,
        address callbackRecipient,
        address escalationManager,
        uint64 liveness,
        IERC20 currency,
        uint256 bond,
        bytes32 identifier,
        bytes32 domainId
    ) external returns (bytes32 assertionId);

    function settleAssertion(bytes32 assertionId) external;

    function disputeAssertion(bytes32 assertionId, address disputer) external;

    function getMinimumBond(address currency) external view returns (uint256);

    function defaultIdentifier() external view returns (bytes32);

    function getAssertionResult(bytes32 assertionId) external view returns (bool);
}

/// @notice Callback surface OOv3 invokes on the asserting contract.
interface IOptimisticOracleV3CallbackRecipient {
    function assertionResolvedCallback(bytes32 assertionId, bool assertedTruthfully) external;
    function assertionDisputedCallback(bytes32 assertionId) external;
}
