// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Surface HouseVault uses for fee routing + rehab positions. Implemented by LockVaultV2.
interface ILockVault {
    /// @notice FULL: voluntary LP lock, withdraws at unlockAt, earns fees.
    /// @notice PARTIAL: credit-win lock; principal locked forever, earnings liquid.
    /// @notice LEAST: loss-driven rehab lock; principal burns at unlockAt.
    enum Tier {
        FULL,
        PARTIAL,
        LEAST
    }

    /// @notice Caller (fee distributor) must transfer USDC in first.
    function notifyFees(uint256 amount) external;

    /// @notice HouseVault-only. tier must be PARTIAL or LEAST; FULL is entered via `lock()`.
    function rehabLock(address user, uint256 shares, uint256 duration, Tier tier) external;
}
