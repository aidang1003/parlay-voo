// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {HelperConfig} from "./HelperConfig.s.sol";
import {CoreStep} from "./steps/CoreStep.sol";
import {LockVaultStep} from "./steps/LockVaultStep.sol";
import {YieldStep} from "./steps/YieldStep.sol";
import {FaucetStep} from "./steps/FaucetStep.sol";
import {SetTrustedSigner} from "./SetTrustedSigner.s.sol";

/// @notice Top-level deploy orchestrator.
/// Per-chain config (USDC address, bootstrap window, oracle params) comes from
/// HelperConfig; each concern lives in script/steps/*.sol and is composed via
/// inheritance so the whole deploy runs inside a single broadcast.
contract Deploy is CoreStep, LockVaultStep, YieldStep, FaucetStep {
    function run() external {
        HelperConfig helperConfig = new HelperConfig();
        HelperConfig.NetworkConfig memory cfg = helperConfig.getConfig();

        address deployer = vm.addr(cfg.deployerKey);
        console.log("Deployer:               ", deployer);
        console.log("Chain ID:               ", block.chainid);

        vm.startBroadcast(cfg.deployerKey);

        CoreDeployment memory core = _deployCore(cfg);
        _deployLockVault(core.vault, deployer);
        _deployYieldAdapter(core.usdc, core.vault);

        if (core.deployedMockUsdc) {
            _mintInitialUsdc(MockUSDC(address(core.usdc)), deployer);
        }

        vm.stopBroadcast();

        new SetTrustedSigner().run(cfg.deployerKey, address(core.engine));
    }
}
