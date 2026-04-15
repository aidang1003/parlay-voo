// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice Mint MockUSDC to a wallet on a chain where MockUSDC was deployed
/// (local Anvil or Base Sepolia with our mock token). Reverts against Circle
/// USDC because its mint function is not public.
///
/// Usage:
///   forge script script/FundWallet.s.sol --sig "run(address,uint256)" \
///     0xWALLET 10000 --rpc-url <rpc> --broadcast
///
/// Reads NEXT_PUBLIC_USDC_ADDRESS + DEPLOYER_PRIVATE_KEY from env
/// (populated into packages/nextjs/.env.local by scripts/sync-env.ts).
contract FundWallet is Script {
    function run(uint256 amountUnits) external {
        address payable userWallet = payable(vm.envAddress("USER_WALLET_ADDRESS"));
        address usdc = vm.envAddress("NEXT_PUBLIC_USDC_ADDRESS");

        require(userWallet != address(0), "userWallet=0");

        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 amount = amountUnits * 1e6; // USDC is 6-decimals

        vm.startBroadcast(key);
        MockUSDC(usdc).mint(userWallet, amount);
        userWallet.transfer(0.1 ether);
        vm.stopBroadcast();

        console.log("Minted to:              ", userWallet);
        console.log("Amount (USDC):          ", amountUnits);
    }
}
