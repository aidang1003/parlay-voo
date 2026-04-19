// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ILockVault
/// @notice Interface HouseVault uses to route fees and mint rehab positions.
///         Implemented by LockVaultV2.
interface ILockVault {
    /// @notice Position classification. Phase 2 onward.
    /// - FULL    : voluntary LP lock, withdrawable at unlockAt, counts in fee-share weight.
    /// - PARTIAL : credit-win lock, principal locked forever, earnings liquid. Phase 3.
    /// - LEAST   : loss-driven rehab lock, principal burns at unlockAt. Phase 2.
    enum Tier {
        FULL,
        PARTIAL,
        LEAST
    }

    /// @notice Notify the lock vault of fee income already transferred in.
    ///         Called by the fee distributor (HouseVault) after pushing USDC.
    function notifyFees(uint256 amount) external;

    /// @notice Record a rehab lock on behalf of `user`. Shares must already be
    ///         approved for transfer from the caller (HouseVault). Only the
    ///         associated HouseVault may call this.
    /// @param user     Beneficiary of the locked position.
    /// @param shares   VOO shares to lock.
    /// @param duration Lock duration in seconds (applied differently per tier).
    /// @param tier     PARTIAL or LEAST. FULL must be entered via `lock()`.
    function rehabLock(address user, uint256 shares, uint256 duration, Tier tier) external;
}
