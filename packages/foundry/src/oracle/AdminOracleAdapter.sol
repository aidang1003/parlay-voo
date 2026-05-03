// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOracleAdapter, LegStatus} from "../interfaces/IOracleAdapter.sol";

/// @notice FAST-mode bootstrap oracle: owner manually resolves legs.
contract AdminOracleAdapter is IOracleAdapter, Ownable {
    struct Resolution {
        LegStatus status;
        bytes32 outcome;
        bool resolved;
    }

    mapping(uint256 => Resolution) private _resolutions;

    event LegResolved(uint256 indexed legId, LegStatus status, bytes32 outcome);

    constructor() Ownable(msg.sender) {}

    /// @dev Disabled on Base mainnet (8453); admin backdoor only acceptable on local + Sepolia. Mainnet uses UmaOracleAdapter.
    function resolve(uint256 legId, LegStatus status, bytes32 outcome) external onlyOwner {
        require(block.chainid != 8453, "AdminOracle: disabled on Base mainnet");
        require(status != LegStatus.Unresolved, "AdminOracle: cannot set Unresolved");
        require(!_resolutions[legId].resolved, "AdminOracle: already resolved");

        _resolutions[legId] = Resolution({status: status, outcome: outcome, resolved: true});

        emit LegResolved(legId, status, outcome);
    }

    /// @inheritdoc IOracleAdapter
    function getStatus(uint256 legId) external view override returns (LegStatus status, bytes32 outcome) {
        Resolution memory r = _resolutions[legId];
        if (!r.resolved) {
            return (LegStatus.Unresolved, bytes32(0));
        }
        return (r.status, r.outcome);
    }

    /// @inheritdoc IOracleAdapter
    function canResolve(uint256 legId) external view override returns (bool) {
        return _resolutions[legId].resolved;
    }
}
