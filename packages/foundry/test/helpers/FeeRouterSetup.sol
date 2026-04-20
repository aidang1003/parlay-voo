// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HouseVault} from "../../src/core/HouseVault.sol";
import {LockVaultV2} from "../../src/core/LockVaultV2.sol";

/// @notice Shared helper for test setUp: deploys LockVaultV2, wires fee routing.
abstract contract FeeRouterSetup is Test {
    function _wireFeeRouter(HouseVault vault) internal returns (LockVaultV2 lockVault) {
        lockVault = new LockVaultV2(vault);
        vault.setLockVault(lockVault);
        vault.setSafetyModule(makeAddr("safetyModule"));
        lockVault.setFeeDistributor(address(vault));
    }
}
