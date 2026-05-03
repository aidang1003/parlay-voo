// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {OnboardingFaucet} from "../src/peripheral/OnboardingFaucet.sol";
import {CodeConstants} from "./HelperConfig.s.sol";

/// @notice Standalone deploy for the testnet onboarding faucet. Excluded from Deploy.s.sol —
///         the faucet is operationally distinct from the protocol so a redeploy of the protocol
///         does not reset the per-address `claimed` map. Funded + owned by QUOTE_SIGNER (hot key)
///         so the cold deployer key can stay offline. See docs/changes/ONBOARDING.md.
///
/// Usage:
///   pnpm deploy:faucet:local
///   pnpm deploy:faucet:sepolia
contract DeployOnboardingFaucet is Script, CodeConstants {
    using stdJson for string;

    /// Default initial seed (Sepolia). Local Anvil seeds 0 — Anvil-funded wallets don't need it.
    uint256 internal constant SEPOLIA_SEED = 0.1 ether;

    function run() external returns (OnboardingFaucet faucet) {
        uint256 pk = block.chainid == LOCAL_CHAIN_ID
            ? vm.envOr("QUOTE_SIGNER_PRIVATE_KEY", vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_ACCOUNT_0_KEY))
            : vm.envOr("QUOTE_SIGNER_PRIVATE_KEY", vm.envUint("DEPLOYER_PRIVATE_KEY"));

        address signer = vm.addr(pk);
        address usdc = _readMockUsdcFromBroadcast();

        require(usdc != address(0), "MockUSDC address not found");

        uint256 seed = block.chainid == LOCAL_CHAIN_ID ? 0 : SEPOLIA_SEED;

        console.log("Deploying OnboardingFaucet");
        console.log("  signer/owner:", signer);
        console.log("  MockUSDC:    ", usdc);
        console.log("  initial seed:", seed);

        vm.startBroadcast(pk);
        faucet = new OnboardingFaucet(usdc, signer);
        if (seed > 0) {
            faucet.fund{value: seed}();
        }
        vm.stopBroadcast();

        console.log("OnboardingFaucet deployed at:", address(faucet));
    }

    function _readMockUsdcFromBroadcast() internal view returns (address) {
        string memory path =
            string.concat("broadcast/Deploy.s.sol/", vm.toString(block.chainid), "/run-latest.json");
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
}
