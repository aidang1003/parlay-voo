// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

/// @dev Chain-agnostic protocol constants. Values that only differ per-chain live
/// in `HelperConfig.NetworkConfig`; values that are the same everywhere stay here.
abstract contract CodeConstants {
    /* Chain IDs */
    uint256 public constant LOCAL_CHAIN_ID = 31337;
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant BASE_MAINNET_CHAIN_ID = 8453;

    /* Circle USDC */
    address internal constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant USDC_BASE_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /* Uniswap V3 (same address across Base mainnet + Sepolia) */
    address internal constant UNISWAP_NFPM = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    address internal constant UNISWAP_SWAP_ROUTER = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address internal constant WETH_BASE = 0x4200000000000000000000000000000000000006;

    /* Protocol defaults */
    uint256 internal constant OPTIMISTIC_LIVENESS = 1800; // 30 minutes
    uint256 internal constant OPTIMISTIC_BOND = 10e6; // 10 USDC

    /* Anvil default key (forge-std test account 0) */
    uint256 internal constant ANVIL_DEFAULT_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
}

/// @notice Per-chain deployment config. Pattern mirrored from eth-stable-ptf's
/// HelperConfig — centralizes all on-chain addresses and protocol parameters so
/// scripts stay free of `if (chainId == X)` branching.
contract HelperConfig is CodeConstants, Script {
    error HelperConfig__InvalidChainId(uint256 chainId);

    struct NetworkConfig {
        /// USDC token address. address(0) signals "deploy MockUSDC as part of this run".
        address usdc;
        /// How long the bootstrap (admin-oracle) window lasts, in days.
        uint256 bootstrapDays;
        /// Optimistic oracle liveness window (seconds).
        uint256 optimisticLiveness;
        /// Optimistic oracle bond (USDC, 6-decimal).
        uint256 optimisticBond;
        /// Uniswap V3 NonfungiblePositionManager (for CreatePool). 0x0 when N/A.
        address uniswapNFPM;
        /// WETH address for the chain. 0x0 when N/A.
        address weth;
        /// Deployer / broadcast signing key. Read from env for real chains,
        /// falls back to the Anvil default key locally.
        uint256 deployerKey;
    }

    mapping(uint256 => NetworkConfig) private _configs;

    constructor() {
        _configs[LOCAL_CHAIN_ID] = getLocalConfig();
        _configs[BASE_SEPOLIA_CHAIN_ID] = getBaseSepoliaConfig();
        _configs[BASE_MAINNET_CHAIN_ID] = getBaseMainnetConfig();
    }

    function getConfig() public view returns (NetworkConfig memory) {
        return getConfigByChainId(block.chainid);
    }

    function getConfigByChainId(uint256 chainId) public view returns (NetworkConfig memory cfg) {
        cfg = _configs[chainId];
        if (cfg.bootstrapDays == 0) revert HelperConfig__InvalidChainId(chainId);
    }

    function getLocalConfig() public view returns (NetworkConfig memory) {
        return NetworkConfig({
            usdc: address(0), // deploy MockUSDC
            bootstrapDays: 7,
            optimisticLiveness: OPTIMISTIC_LIVENESS,
            optimisticBond: OPTIMISTIC_BOND,
            uniswapNFPM: address(0),
            weth: address(0),
            deployerKey: vm.envOr("PRIVATE_KEY", ANVIL_DEFAULT_KEY)
        });
    }

    function getBaseSepoliaConfig() public view returns (NetworkConfig memory) {
        // USDC override allowed for testing with a custom token on Sepolia.
        address usdc = vm.envOr("USDC_ADDRESS", USDC_BASE_SEPOLIA);
        return NetworkConfig({
            usdc: usdc,
            bootstrapDays: vm.envOr("BOOTSTRAP_DAYS", uint256(30)),
            optimisticLiveness: OPTIMISTIC_LIVENESS,
            optimisticBond: OPTIMISTIC_BOND,
            uniswapNFPM: UNISWAP_NFPM,
            weth: WETH_BASE,
            deployerKey: vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0))
        });
    }

    function getBaseMainnetConfig() public view returns (NetworkConfig memory) {
        return NetworkConfig({
            usdc: USDC_BASE_MAINNET,
            bootstrapDays: vm.envOr("BOOTSTRAP_DAYS", uint256(30)),
            optimisticLiveness: OPTIMISTIC_LIVENESS,
            optimisticBond: OPTIMISTIC_BOND,
            uniswapNFPM: UNISWAP_NFPM,
            weth: WETH_BASE,
            deployerKey: vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0))
        });
    }
}
