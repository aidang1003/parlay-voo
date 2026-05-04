// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MockUSDC} from "../contracts/MockUSDC.sol";
import {CodeConstants} from "./HelperConfig.s.sol";

/// @notice Mint MockUSDC + (on local Anvil) fund ETH to a wallet.
///
/// Usage:
///   pnpm fund-wallet:local 10000
///   pnpm fund-wallet:sepolia 10000
///
/// For one-off ETH on Anvil without this script (well-known anvil #0 key; never use on a real chain):
///   cast send 0xYOUR_WALLET --value 0.1ether --rpc-url http://127.0.0.1:8545 \
///     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
contract FundWallet is Script, CodeConstants {
    using stdJson for string;

    function _readMockUsdcFromBroadcast() internal view returns (address) {
        string memory path = string.concat("broadcast/Deploy.s.sol/", vm.toString(block.chainid), "/run-latest.json");
        string memory json = vm.readFile(path);
        bytes32 target = keccak256(bytes("MockUSDC"));
        for (uint256 i = 0; i < 256; i++) {
            string memory base = string.concat(".transactions[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, base)) break;
            string memory nameKey = string.concat(base, ".contractName");
            if (!vm.keyExistsJson(json, nameKey)) continue;
            bytes memory raw = vm.parseJson(json, nameKey);
            if (raw.length == 0) continue;
            string memory name = abi.decode(raw, (string));
            if (keccak256(bytes(name)) == target) {
                return json.readAddress(string.concat(base, ".contractAddress"));
            }
        }
        revert("MockUSDC not found in run-latest.json");
    }

    function run(uint256 amountUnits) external {
        address payable userWallet = payable(vm.envAddress("USER_WALLET_ADDRESS"));
        address usdc = _readMockUsdcFromBroadcast();

        require(userWallet != address(0), "userWallet=0");

        // Local Anvil falls back to the well-known account #0 so devs can fund a wallet
        // with zero env setup. Remote chains must supply the real deployer key (MockUSDC owner).
        uint256 key = block.chainid == LOCAL_CHAIN_ID
            ? vm.envOr("WARM_DEPLOYER_PRIVATE_KEY", ANVIL_ACCOUNT_0_KEY)
            : vm.envUint("WARM_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        uint256 amount = amountUnits * 1e6; // USDC is 6-decimals

        // On local Anvil, fund the deployer and user wallet from account #0.
        if (block.chainid == LOCAL_CHAIN_ID) {
            vm.startBroadcast(ANVIL_ACCOUNT_0_KEY);
            if (deployer.balance < 0.01 ether) {
                payable(deployer).transfer(0.1 ether);
            }
            if (userWallet.balance < 0.01 ether) {
                userWallet.transfer(0.1 ether);
            }
            vm.stopBroadcast();
        }

        vm.startBroadcast(key);
        MockUSDC(usdc).mint(userWallet, amount);
        vm.stopBroadcast();

        console.log("Minted to:              ", userWallet);
        console.log("Amount (USDC):          ", amountUnits);
    }
}
