/**
 * Single source of truth for chain configuration across the project.
 *
 * Mirrors the values in `packages/foundry/script/HelperConfig.s.sol`. Solidity
 * scripts read HelperConfig; TypeScript scripts + the Next.js frontend read
 * this file.
 *
 * RPC strategy: `getRpcUrl(chainId)` builds the URL from `ALCHEMY_API_KEY`
 * (the primary, single env knob the user sets). Per-chain `*_RPC_URL` env
 * vars are an optional override. Anvil is the only chain with a hardcoded
 * localhost RPC. Public RPCs are NOT hardcoded — set `ALCHEMY_API_KEY`.
 */

export const LOCAL_CHAIN_ID = 31337;
export const MAINNET_CHAIN_ID = 1;
export const SEPOLIA_CHAIN_ID = 11155111;
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_MAINNET_CHAIN_ID = 8453;

/** Well-known Anvil default key (forge-std test account #0). Safe to embed —
 *  published in foundry docs. Mirrors `CodeConstants.ANVIL_ACCOUNT_0_KEY` in
 *  `packages/foundry/script/HelperConfig.s.sol`. NEVER use on a non-local chain. */
export const ANVIL_ACCOUNT_0_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

export type SupportedChainId =
  | typeof LOCAL_CHAIN_ID
  | typeof MAINNET_CHAIN_ID
  | typeof SEPOLIA_CHAIN_ID
  | typeof BASE_SEPOLIA_CHAIN_ID
  | typeof BASE_MAINNET_CHAIN_ID;

export interface ChainInfo {
  id: SupportedChainId;
  name: string;
  /** Alchemy v2 hostname (`<network>.g.alchemy.com`). Undefined for chains
   *  Alchemy doesn't support (Anvil). Used by `getRpcUrl()` to build the URL
   *  `https://<host>/v2/<ALCHEMY_API_KEY>`. */
  alchemyHostname?: string;
  /** Optional per-chain override env var. When set in the user's `.env`,
   *  takes precedence over the Alchemy URL. */
  rpcEnvVar?: string;
  /** Forge `--rpc-url <name>` alias, matches `[rpc_endpoints]` in foundry.toml. */
  forgeRpcAlias: string;
  /** Block explorer base URL, no trailing slash. Empty for local. */
  explorerUrl: string;
  /** Canonical Circle USDC on this chain. Undefined for local. Mirrors
   *  `USDC_*` constants in `HelperConfig.s.sol`. */
  circleUsdc?: `0x${string}`;
}

export const CHAINS: Record<SupportedChainId, ChainInfo> = {
  [LOCAL_CHAIN_ID]: {
    id: LOCAL_CHAIN_ID,
    name: "Anvil",
    forgeRpcAlias: "local",
    explorerUrl: "",
  },
  [MAINNET_CHAIN_ID]: {
    id: MAINNET_CHAIN_ID,
    name: "Ethereum",
    alchemyHostname: "eth-mainnet.g.alchemy.com",
    rpcEnvVar: "NEXT_PUBLIC_MAINNET_RPC_URL",
    forgeRpcAlias: "mainnet",
    explorerUrl: "https://etherscan.io",
    circleUsdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  [SEPOLIA_CHAIN_ID]: {
    id: SEPOLIA_CHAIN_ID,
    name: "Sepolia",
    alchemyHostname: "eth-sepolia.g.alchemy.com",
    rpcEnvVar: "NEXT_PUBLIC_SEPOLIA_RPC_URL",
    forgeRpcAlias: "sepolia",
    explorerUrl: "https://sepolia.etherscan.io",
    circleUsdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  },
  [BASE_SEPOLIA_CHAIN_ID]: {
    id: BASE_SEPOLIA_CHAIN_ID,
    name: "Base Sepolia",
    alchemyHostname: "base-sepolia.g.alchemy.com",
    rpcEnvVar: "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL",
    forgeRpcAlias: "base-sepolia",
    explorerUrl: "https://sepolia.basescan.org",
    circleUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  [BASE_MAINNET_CHAIN_ID]: {
    id: BASE_MAINNET_CHAIN_ID,
    name: "Base",
    alchemyHostname: "base-mainnet.g.alchemy.com",
    rpcEnvVar: "NEXT_PUBLIC_BASE_MAINNET_RPC_URL",
    forgeRpcAlias: "base-mainnet",
    explorerUrl: "https://basescan.org",
    circleUsdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

/** True if `address` is the canonical Circle USDC on `chainId`. */
export function isCircleUsdc(chainId: SupportedChainId, address: string | undefined): boolean {
  const canonical = CHAINS[chainId]?.circleUsdc;
  if (!canonical || !address) return false;
  return canonical.toLowerCase() === address.toLowerCase();
}

/**
 * Resolve the RPC URL for a chain. Lookup order:
 *  1. The chain's `rpcEnvVar` if set in env (per-chain override).
 *  2. Anvil local: hardcoded `http://127.0.0.1:8545`.
 *  3. Alchemy URL built from `ALCHEMY_API_KEY` (or its NEXT_PUBLIC_ mirror) +
 *     the chain's `alchemyHostname`.
 *  4. Throw — caller must set `ALCHEMY_API_KEY` or the chain's override env.
 */
export function getRpcUrl(
  chainId: SupportedChainId,
  env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {}) as Record<
    string,
    string | undefined
  >,
): string {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unknown chain id: ${chainId}`);
  if (chain.rpcEnvVar) {
    const override = env[chain.rpcEnvVar];
    if (override && override.length > 0) return override;
  }
  if (chainId === LOCAL_CHAIN_ID) return "http://127.0.0.1:8545";
  const alchemyKey = env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  if (alchemyKey && chain.alchemyHostname) {
    return `https://${chain.alchemyHostname}/v2/${alchemyKey}`;
  }
  throw new Error(
    `No RPC URL for chain ${chainId} (${chain.name}). Set NEXT_PUBLIC_ALCHEMY_API_KEY in .env, ` +
      `or override with ${chain.rpcEnvVar ?? "<no override env>"}.`,
  );
}

/** Pick a chain by its forge alias (e.g. "local", "base-sepolia"). */
export function chainByForgeAlias(alias: string): ChainInfo | undefined {
  return Object.values(CHAINS).find(c => c.forgeRpcAlias === alias);
}

/** Heuristic: classify a raw RPC URL back to its chainId. */
export function chainIdFromRpcUrl(rpcUrl: string): SupportedChainId {
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") || rpcUrl.includes("0.0.0.0")) {
    return LOCAL_CHAIN_ID;
  }
  // Order matters: check Base before generic "sepolia" since base-sepolia matches both.
  if (rpcUrl.includes("base.org") && rpcUrl.includes("sepolia")) return BASE_SEPOLIA_CHAIN_ID;
  if (rpcUrl.includes("base.org") || rpcUrl.includes("base-mainnet")) return BASE_MAINNET_CHAIN_ID;
  if (rpcUrl.includes("sepolia")) return SEPOLIA_CHAIN_ID;
  if (rpcUrl.includes("eth-mainnet") || rpcUrl.includes("eth.llamarpc") || rpcUrl.includes("cloudflare-eth")) {
    return MAINNET_CHAIN_ID;
  }
  throw new Error(`Cannot infer chainId from RPC URL: ${rpcUrl}`);
}
