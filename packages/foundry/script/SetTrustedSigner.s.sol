// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

interface IParlayEngine {
    function setTrustedQuoteSigner(address signer) external;
}

contract SetTrustedSigner is Script {
    function run() public {
        // The original deployer (owner) key used to authorize the transaction
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        // The new vanity key used to derive the trusted signer address
        uint256 signerPrivateKey = vm.envUint("QUOTE_SIGNER_PRIVATE_KEY");
        address signerAddress = vm.addr(signerPrivateKey);

        // Read the ParlayEngine address from environment variables
        address parlayEngineAddress = vm.envOr("NEXT_PUBLIC_PARLAY_ENGINE_ADDRESS", address(0));
        require(parlayEngineAddress != address(0), "ParlayEngine address not found in env");

        console.log("Target ParlayEngine:", parlayEngineAddress);
        console.log("Setting Trusted Signer To:", signerAddress);

        // Start broadcasting transactions using the deployer's private key
        vm.startBroadcast(deployerPrivateKey);
        IParlayEngine(parlayEngineAddress).setTrustedQuoteSigner(signerAddress);
        vm.stopBroadcast();

        console.log("Successfully updated trusted quote signer!");
    }
}
