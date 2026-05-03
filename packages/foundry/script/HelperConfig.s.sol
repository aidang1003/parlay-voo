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

    /* UMA Optimistic Oracle V3 (from UMAprotocol/protocol/packages/core/networks/<chainId>.json) */
    address internal constant UMA_OOV3_BASE_SEPOLIA = 0x0F7fC5E6482f096380db6158f978167b57388deE;
    address internal constant UMA_OOV3_BASE_MAINNET = 0x2aBf1Bd76655de80eDB3086114315Eec75AF500c;

    /* Uniswap V3 (same address across Base mainnet + Sepolia) */
    address internal constant UNISWAP_NFPM = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    address internal constant UNISWAP_SWAP_ROUTER = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address internal constant WETH_BASE = 0x4200000000000000000000000000000000000006;

    /* Protocol defaults */
    uint64 internal constant UMA_DEFAULT_LIVENESS = 7200; // 2 hours (F-5; tune later)
    uint256 internal constant UMA_BOND_SENTINEL = 0; // sentinel: "use oo.getMinimumBond(USDC) at deploy"

    /* Correlation engine defaults — keep in lockstep with packages/shared/src/constants.ts. */
    uint256 internal constant DEFAULT_PROTOCOL_FEE_BPS = 1000; // 10% per leg
    uint256 internal constant DEFAULT_CORR_ASYMPTOTE_BPS = 8000; // D = 80%
    uint256 internal constant DEFAULT_CORR_HALF_SAT_PPM = 1_000_000; // k = 1.0
    uint256 internal constant DEFAULT_MAX_LEGS_PER_GROUP = 3;

    /* Anvil default keys (forge-std test accounts 0-2). Published foundry defaults — safe to embed. */
    uint256 internal constant ANVIL_ACCOUNT_0_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant ANVIL_ACCOUNT_1_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant ANVIL_ACCOUNT_2_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
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
        /// UMA Optimistic Oracle V3 address. 0x0 means "skip UmaOracleAdapter deploy"
        /// (used on Anvil; admin path covers local dev).
        address umaOracleV3;
        /// UMA dispute liveness window (seconds). Ignored when umaOracleV3 == 0x0.
        uint64 umaLiveness;
        /// UMA bond (USDC, 6-decimal). 0 means "use oo.getMinimumBond(USDC) at deploy".
        uint256 umaBondAmount;
        /// Uniswap V3 NonfungiblePositionManager (for CreatePool). 0x0 when N/A.
        address uniswapNFPM;
        /// WETH address for the chain. 0x0 when N/A.
        address weth;
        /// Deployer / broadcast signing key. Read from env for real chains,
        /// falls back to the Anvil default key locally.
        uint256 deployerKey;
        /// Per-leg multiplicative protocol fee (BPS). See docs/changes/B_SLOG_SPRINT.md.
        uint256 protocolFeeBps;
        /// Correlation asymptote `D` (BPS).
        uint256 corrAsymptoteBps;
        /// Correlation half-saturation `k` (PPM). 1e6 = k=1.0.
        uint256 corrHalfSatPpm;
        /// Builder-side hard cap on legs per correlation group.
        uint256 maxLegsPerGroup;
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
            umaOracleV3: address(0), // skip UmaOracleAdapter on Anvil
            umaLiveness: 0,
            umaBondAmount: 0,
            uniswapNFPM: address(0),
            weth: address(0),
            deployerKey: vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_ACCOUNT_0_KEY),
            protocolFeeBps: vm.envOr("NEXT_PUBLIC_PROTOCOL_FEE_BPS", DEFAULT_PROTOCOL_FEE_BPS),
            corrAsymptoteBps: vm.envOr("NEXT_PUBLIC_CORRELATION_ASYMPTOTE_BPS", DEFAULT_CORR_ASYMPTOTE_BPS),
            corrHalfSatPpm: vm.envOr("NEXT_PUBLIC_CORRELATION_HALF_SAT_PPM", DEFAULT_CORR_HALF_SAT_PPM),
            maxLegsPerGroup: vm.envOr("NEXT_PUBLIC_MAX_LEGS_PER_GROUP", DEFAULT_MAX_LEGS_PER_GROUP)
        });
    }

    function getBaseSepoliaConfig() public view returns (NetworkConfig memory) {
        // Default to deploying MockUSDC so the in-app mint button works on testnet.
        // Set USDC_ADDRESS=<real Circle USDC> to test against Circle's faucet token instead.
        address usdc = vm.envOr("USDC_ADDRESS", address(0));
        return NetworkConfig({
            usdc: usdc,
            bootstrapDays: vm.envOr("BOOTSTRAP_DAYS", uint256(30)),
            umaOracleV3: UMA_OOV3_BASE_SEPOLIA,
            umaLiveness: UMA_DEFAULT_LIVENESS,
            umaBondAmount: UMA_BOND_SENTINEL,
            uniswapNFPM: UNISWAP_NFPM,
            weth: WETH_BASE,
            deployerKey: vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0)),
            protocolFeeBps: vm.envOr("NEXT_PUBLIC_PROTOCOL_FEE_BPS", DEFAULT_PROTOCOL_FEE_BPS),
            corrAsymptoteBps: vm.envOr("NEXT_PUBLIC_CORRELATION_ASYMPTOTE_BPS", DEFAULT_CORR_ASYMPTOTE_BPS),
            corrHalfSatPpm: vm.envOr("NEXT_PUBLIC_CORRELATION_HALF_SAT_PPM", DEFAULT_CORR_HALF_SAT_PPM),
            maxLegsPerGroup: vm.envOr("NEXT_PUBLIC_MAX_LEGS_PER_GROUP", DEFAULT_MAX_LEGS_PER_GROUP)
        });
    }

    function getBaseMainnetConfig() public view returns (NetworkConfig memory) {
        return NetworkConfig({
            usdc: USDC_BASE_MAINNET,
            bootstrapDays: vm.envOr("BOOTSTRAP_DAYS", uint256(30)),
            umaOracleV3: UMA_OOV3_BASE_MAINNET,
            umaLiveness: UMA_DEFAULT_LIVENESS,
            umaBondAmount: UMA_BOND_SENTINEL,
            uniswapNFPM: UNISWAP_NFPM,
            weth: WETH_BASE,
            deployerKey: vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0)),
            protocolFeeBps: vm.envOr("NEXT_PUBLIC_PROTOCOL_FEE_BPS", DEFAULT_PROTOCOL_FEE_BPS),
            corrAsymptoteBps: vm.envOr("NEXT_PUBLIC_CORRELATION_ASYMPTOTE_BPS", DEFAULT_CORR_ASYMPTOTE_BPS),
            corrHalfSatPpm: vm.envOr("NEXT_PUBLIC_CORRELATION_HALF_SAT_PPM", DEFAULT_CORR_HALF_SAT_PPM),
            maxLegsPerGroup: vm.envOr("NEXT_PUBLIC_MAX_LEGS_PER_GROUP", DEFAULT_MAX_LEGS_PER_GROUP)
        });
    }
}
