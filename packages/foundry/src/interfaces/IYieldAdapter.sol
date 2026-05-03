// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Routes idle vault capital to external yield sources.
interface IYieldAdapter {
    function deploy(uint256 amount) external;

    function withdraw(uint256 amount) external;

    /// @notice Principal + accrued yield.
    function balance() external view returns (uint256);

    function emergencyWithdraw() external;
}
