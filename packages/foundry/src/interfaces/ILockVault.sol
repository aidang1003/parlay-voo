// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ILockVault
/// @notice Minimal interface HouseVault needs to route fees to a lock vault.
///         Implemented by both LockVault (V1, deprecated) and LockVaultV2.
interface ILockVault {
    /// @notice Notify the lock vault of fee income already transferred in.
    ///         Called by the fee distributor (HouseVault) after pushing USDC.
    function notifyFees(uint256 amount) external;
}
