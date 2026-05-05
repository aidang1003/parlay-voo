// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../../contracts/MockUSDC.sol";
import {HouseVault} from "../../contracts/core/HouseVault.sol";
import {LegRegistry} from "../../contracts/core/LegRegistry.sol";
import {ParlayEngine} from "../../contracts/core/ParlayEngine.sol";
import {AdminOracleAdapter} from "../../contracts/oracle/AdminOracleAdapter.sol";
import {UmaOracleAdapter} from "../../contracts/oracle/UmaOracleAdapter.sol";
import {IOptimisticOracleV3} from "../../contracts/interfaces/IOptimisticOracleV3.sol";
import {HelperConfig} from "../HelperConfig.s.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

abstract contract CoreStep is Script {
    struct CoreDeployment {
        IERC20 usdc;
        bool deployedMockUsdc;
        HouseVault vault;
        LegRegistry registry;
        AdminOracleAdapter adminOracle;
        UmaOracleAdapter umaOracle; // address(0) on chains without UMA (Anvil)
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
            if (block.chainid == 1 || block.chainid == 8453) {
                console.log("!! WARNING: MockUSDC deployed on a MAINNET chain.");
                console.log("!! Vault will hold a worthless mock token. Set USE_REAL_USDC=true if unintended.");
            } else if (block.chainid != 31337) {
                console.log("!! WARNING: Fresh MockUSDC deployed on a non-local chain.");
                console.log("!! Any previously-deployed contracts referencing MockUSDC now point to the OLD address.");
                console.log("!! To reuse an existing MockUSDC, set MOCK_USDC_ADDRESS in your env.");
            }
        }

        d.vault = new HouseVault(d.usdc, cfg.corrAsymptoteBps, cfg.corrHalfSatPpm, cfg.maxLegsPerGroup);
        console.log("HouseVault:             ", address(d.vault));
        console.log("  corr D (BPS):         ", cfg.corrAsymptoteBps);
        console.log("  corr k (PPM):         ", cfg.corrHalfSatPpm);
        console.log("  maxLegsPerGroup:      ", cfg.maxLegsPerGroup);

        d.registry = new LegRegistry();
        console.log("LegRegistry:            ", address(d.registry));

        d.adminOracle = new AdminOracleAdapter();
        console.log("AdminOracleAdapter:     ", address(d.adminOracle));

        if (cfg.umaOracleV3 != address(0)) {
            IOptimisticOracleV3 uma = IOptimisticOracleV3(cfg.umaOracleV3);
            uint256 bond = cfg.umaBondAmount == 0 ? uma.getMinimumBond(address(d.usdc)) : cfg.umaBondAmount;
            d.umaOracle = new UmaOracleAdapter(uma, d.usdc, cfg.umaLiveness, bond);
            console.log("UmaOracleAdapter:       ", address(d.umaOracle));
            console.log("  UMA OOv3:             ", cfg.umaOracleV3);
            console.log("  liveness (s):         ", cfg.umaLiveness);
            console.log("  bond (USDC 6dp):      ", bond);
        } else {
            console.log("UmaOracleAdapter:        skipped (no UMA on this chain)");
        }

        uint256 bootstrapEndsAt = block.timestamp + cfg.bootstrapDays * 1 days;
        d.engine = new ParlayEngine(d.vault, d.registry, d.usdc, bootstrapEndsAt, cfg.protocolFeeBps);
        console.log("ParlayEngine:           ", address(d.engine));
        console.log("  protocolFeeBps:       ", cfg.protocolFeeBps);

        d.vault.setEngine(address(d.engine));
        d.registry.setEngine(address(d.engine));
        console.log("Engine authorized on vault + registry");
    }
}
