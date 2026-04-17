// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {HouseVault} from "../../src/core/HouseVault.sol";
import {LockVault} from "../../src/core/LockVault.sol";

abstract contract LockVaultStep is Script {
    function _deployLockVault(HouseVault vault, address safetyModulePlaceholder)
        internal
        returns (LockVault lockVault)
    {
        lockVault = new LockVault(vault);
        console.log("LockVault:              ", address(lockVault));

        vault.setLockVault(lockVault);
        // SafetyModule doesn't exist yet -- use deployer as placeholder.
        // TODO: Replace with real SafetyModule address in PR2.
        vault.setSafetyModule(safetyModulePlaceholder);
        lockVault.setFeeDistributor(address(vault));
    }
}
