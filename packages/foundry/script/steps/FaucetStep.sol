// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../../contracts/MockUSDC.sol";

abstract contract FaucetStep is Script {
    function _mintInitialUsdc(MockUSDC mockUsdc, address deployer) internal {
        mockUsdc.mint(deployer, 10_000e6);
        console.log("Minted 10,000 USDC to deployer");

        if (block.chainid == 31337) {
            address anvilAccount1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
            mockUsdc.mint(anvilAccount1, 10_000e6);
            console.log("Minted 10,000 USDC to account1 (Anvil)");
        }
    }
}
