// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {HouseVault} from "../src/core/HouseVault.sol";
import {LegRegistry} from "../src/core/LegRegistry.sol";
import {HelperConfig} from "./HelperConfig.s.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Seed a deployed stack with sample LP liquidity + admin-created legs.
///
/// Ticket creation is intentionally omitted here because ParlayEngine now only
/// accepts signed JIT quotes (see `buyTicketSigned`) — which means the frontend
/// / `scripts/risk-agent.ts` is the right way to create tickets. This script
/// covers the on-chain prerequisites that still work from pure Solidity.
///
/// Reads addresses from the NEXT_PUBLIC_* env vars populated by
/// `scripts/sync-env.ts`. Requires DEPLOYER_PRIVATE_KEY (and, off-local,
/// ACCOUNT1_PRIVATE_KEY) in env.
contract DemoSeed is Script {
    function run() external {
        address usdc = vm.envAddress("NEXT_PUBLIC_USDC_ADDRESS");
        address vault = vm.envAddress("NEXT_PUBLIC_HOUSE_VAULT_ADDRESS");
        address registry = vm.envAddress("NEXT_PUBLIC_LEG_REGISTRY_ADDRESS");
        address oracle = vm.envAddress("NEXT_PUBLIC_ADMIN_ORACLE_ADDRESS");

        // Use the same key derivation as Deploy.s.sol so LP actions come from
        // whichever account was funded at deploy time.
        HelperConfig.NetworkConfig memory cfg = (new HelperConfig()).getConfig();
        uint256 deployerKey = cfg.deployerKey;
        uint256 account1Key = vm.envOr("ACCOUNT1_PRIVATE_KEY", _anvilAccount1(block.chainid));
        address deployer = vm.addr(deployerKey);
        address account1 = vm.addr(account1Key);

        (uint256 lpDeployer, uint256 lpAccount1) = _lpAmounts(block.chainid);
        bool mintable = _isMintable(usdc, deployer);

        console.log("=== ParlayCity Demo Seed ===");
        console.log("Chain ID:    ", block.chainid);
        console.log("Deployer:    ", deployer);
        console.log("Account1:    ", account1);
        console.log("USDC (mint?):", mintable);

        _seedLp(usdc, vault, deployer, account1, deployerKey, account1Key, lpDeployer, lpAccount1, mintable);
        _createLegs(registry, oracle, deployerKey);

        console.log("=== Seed Complete ===");
    }

    function _lpAmounts(uint256 chainId) internal pure returns (uint256 dep, uint256 acc1) {
        if (chainId == 31337) return (600e6, 400e6);
        return (50e6, 30e6); // testnet / mainnet: smaller
    }

    function _anvilAccount1(uint256 chainId) internal pure returns (uint256) {
        require(chainId == 31337, "ACCOUNT1_PRIVATE_KEY required off-local");
        return 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    }

    function _isMintable(address usdc, address probe) internal returns (bool) {
        // Probe with a zero-amount mint to a known EOA. MockUSDC allows this;
        // Circle USDC has no public mint and reverts.
        try MockUSDC(usdc).mint(probe, 0) {
            return true;
        } catch {
            return false;
        }
    }

    function _seedLp(
        address usdc,
        address vault,
        address deployer,
        address account1,
        uint256 deployerKey,
        uint256 account1Key,
        uint256 lpDeployer,
        uint256 lpAccount1,
        bool mintable
    ) internal {
        if (mintable) {
            vm.startBroadcast(deployerKey);
            MockUSDC(usdc).mint(deployer, lpDeployer);
            MockUSDC(usdc).mint(account1, lpAccount1);
            vm.stopBroadcast();
        }

        vm.startBroadcast(deployerKey);
        IERC20(usdc).approve(vault, lpDeployer);
        HouseVault(vault).deposit(lpDeployer, deployer);
        vm.stopBroadcast();

        vm.startBroadcast(account1Key);
        IERC20(usdc).approve(vault, lpAccount1);
        HouseVault(vault).deposit(lpAccount1, account1);
        vm.stopBroadcast();

        console.log("LP seeded. Deployer USDC:", lpDeployer);
        console.log("LP seeded. Account1 USDC:", lpAccount1);
    }

    function _createLegs(address registry, address oracle, uint256 deployerKey) internal {
        uint256 cutoff = block.timestamp + 1 days;
        uint256 resolve = cutoff + 1 hours;

        string[5] memory questions = [
            "Will ETH break $5000 by March 2026?",
            "Will BTC reach $200k by March 2026?",
            "Will SOL flip $400 by March 2026?",
            "Will Base TVL exceed $20B by March 2026?",
            "Will ETHDenver 2026 have 20k+ attendees?"
        ];
        string[5] memory sources =
            ["coingecko:eth", "coingecko:btc", "coingecko:sol", "defillama:base", "manual:ethdenver"];
        uint256[5] memory probs = [uint256(350000), 250000, 200000, 400000, 600000];

        LegRegistry reg = LegRegistry(registry);
        uint256 firstId = reg.legCount();

        vm.startBroadcast(deployerKey);
        for (uint256 i = 0; i < 5; i++) {
            reg.createLeg(questions[i], sources[i], cutoff, resolve, oracle, probs[i]);
        }
        vm.stopBroadcast();

        console.log("Legs created. First ID:", firstId);
    }
}
