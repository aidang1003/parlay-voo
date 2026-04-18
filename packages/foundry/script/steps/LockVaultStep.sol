// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {HouseVault} from "../../src/core/HouseVault.sol";
import {LockVaultV2} from "../../src/core/LockVaultV2.sol";

abstract contract LockVaultStep is Script {
    function _deployLockVault(HouseVault vault, address safetyModulePlaceholder)
        internal
        returns (LockVaultV2 lockVault)
    {
        lockVault = new LockVaultV2(vault);
        console.log("LockVaultV2:            ", address(lockVault));

        vault.setLockVault(lockVault);
        // SafetyModule doesn't exist yet -- use deployer as placeholder.
        // TODO: Replace with real SafetyModule address in PR2.
        vault.setSafetyModule(safetyModulePlaceholder);
        lockVault.setFeeDistributor(address(vault));
    }
}
