// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {HouseVault} from "../../src/core/HouseVault.sol";
import {MockYieldAdapter} from "../../src/yield/MockYieldAdapter.sol";
import {IYieldAdapter} from "../../src/interfaces/IYieldAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

abstract contract YieldStep is Script {
    function _deployYieldAdapter(IERC20 usdc, HouseVault vault) internal returns (MockYieldAdapter adapter) {
        adapter = new MockYieldAdapter(usdc, address(vault));
        console.log("MockYieldAdapter:       ", address(adapter));
        vault.setYieldAdapter(IYieldAdapter(address(adapter)));
        console.log("YieldAdapter wired on vault");
    }
}
