// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

interface IParlayEngine {
    function setTrustedQuoteSigner(address signer) external;
}

contract SetTrustedSigner is Script {
    /// @notice Sets the trusted quote signer on the ParlayEngine owned by `ownerKey`.
    /// Called as a composable step from Deploy.s.sol (passes its own deployerKey in)
    /// and standalone via `forge script ... --sig "run()"` (reads env).
    function run(uint256 ownerKey, address engineAddress) public {
        // Defaults to the owner key when HOT_SIGNER_PRIVATE_KEY is unset, so a single
        // funded wallet works across local + testnet. Mainnet should set this explicitly
        // to keep the quote signer (hot) separate from the owner (cold).
        uint256 signerPrivateKey = vm.envOr("HOT_SIGNER_PRIVATE_KEY", ownerKey);
        address signerAddress = vm.addr(signerPrivateKey);

        require(engineAddress != address(0), "ParlayEngine address required");

        console.log("Target ParlayEngine:", engineAddress);
        console.log("Setting Trusted Signer To:", signerAddress);

        vm.startBroadcast(ownerKey);
        IParlayEngine(engineAddress).setTrustedQuoteSigner(signerAddress);
        vm.stopBroadcast();
    }

    /// @notice Standalone entrypoint — reads owner key + engine address from env.
    function run() external {
        uint256 ownerKey = vm.envUint("WARM_DEPLOYER_PRIVATE_KEY");
        address engineAddress = vm.envAddress("NEXT_PUBLIC_PARLAY_ENGINE_ADDRESS");
        run(ownerKey, engineAddress);
    }
}
