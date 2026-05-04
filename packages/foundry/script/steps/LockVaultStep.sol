// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {HouseVault} from "../../contracts/core/HouseVault.sol";
import {LockVaultV2} from "../../contracts/core/LockVaultV2.sol";

abstract contract LockVaultStep is Script {
    function _deployLockVault(HouseVault vault, address safetyModulePlaceholder)
        internal
        returns (LockVaultV2 lockVault)
    {
        lockVault = new LockVaultV2(vault);
        console.log("LockVaultV2:            ", address(lockVault));

        vault.setLockVault(lockVault);
        // SafetyModule isn't implemented yet; caller passes a placeholder (usually the deployer).
        vault.setSafetyModule(safetyModulePlaceholder);
        lockVault.setFeeDistributor(address(vault));
        console.log("LockVault + SafetyModule wired on vault; FeeDistributor set on LockVault");
    }
}
