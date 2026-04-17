// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../../src/MockUSDC.sol";
import {HouseVault} from "../../src/core/HouseVault.sol";
import {LegRegistry} from "../../src/core/LegRegistry.sol";
import {ParlayEngine} from "../../src/core/ParlayEngine.sol";
import {AdminOracleAdapter} from "../../src/oracle/AdminOracleAdapter.sol";
import {OptimisticOracleAdapter} from "../../src/oracle/OptimisticOracleAdapter.sol";
import {HelperConfig} from "../HelperConfig.s.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

abstract contract CoreStep is Script {
    struct CoreDeployment {
        IERC20 usdc;
        bool deployedMockUsdc;
        HouseVault vault;
        LegRegistry registry;
        AdminOracleAdapter adminOracle;
        OptimisticOracleAdapter optimisticOracle;
        ParlayEngine engine;
    }

    function _deployCore(HelperConfig.NetworkConfig memory cfg) internal returns (CoreDeployment memory d) {
        if (cfg.usdc != address(0)) {
            d.usdc = IERC20(cfg.usdc);
            console.log("Using external USDC:    ", cfg.usdc);
        } else {
            d.usdc = IERC20(address(new MockUSDC()));
            d.deployedMockUsdc = true;
            console.log("Deployed MockUSDC:      ", address(d.usdc));
        }

        d.vault = new HouseVault(d.usdc);
        console.log("HouseVault:             ", address(d.vault));

        d.registry = new LegRegistry();
        console.log("LegRegistry:            ", address(d.registry));

        d.adminOracle = new AdminOracleAdapter();
        console.log("AdminOracleAdapter:     ", address(d.adminOracle));

        d.optimisticOracle = new OptimisticOracleAdapter(d.usdc, cfg.optimisticLiveness, cfg.optimisticBond);
        console.log("OptimisticOracleAdapter:", address(d.optimisticOracle));

        uint256 bootstrapEndsAt = block.timestamp + cfg.bootstrapDays * 1 days;
        d.engine = new ParlayEngine(d.vault, d.registry, d.usdc, bootstrapEndsAt);
        console.log("ParlayEngine:           ", address(d.engine));

        d.vault.setEngine(address(d.engine));
        d.registry.setEngine(address(d.engine));
        console.log("Engine authorized on vault + registry");
    }
}
