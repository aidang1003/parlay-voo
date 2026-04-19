/**
 * Single source of truth for chain configuration across the project.
 *
 * Mirrors the values in `packages/foundry/script/HelperConfig.s.sol`. Solidity
 * scripts read HelperConfig; TypeScript scripts + the Next.js frontend read
 * this file. RPC URLs that depend on private API keys are opt-in env-driven
 * overrides; everything else is keyed by chainId.
 */

export const LOCAL_CHAIN_ID = 31337;
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_MAINNET_CHAIN_ID = 8453;

/** Well-known Anvil default key (forge-std test account #0). Safe to embed —
 *  published in foundry docs. Mirrors `CodeConstants.ANVIL_ACCOUNT_0_KEY` in
 *  `packages/foundry/script/HelperConfig.s.sol`. NEVER use on a non-local chain. */
export const ANVIL_ACCOUNT_0_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

export type SupportedChainId =
  | typeof LOCAL_CHAIN_ID
  | typeof BASE_SEPOLIA_CHAIN_ID
  | typeof BASE_MAINNET_CHAIN_ID;

export interface ChainInfo {
  id: SupportedChainId;
  name: string;
  /** Default public RPC. Override via env where listed. */
  defaultRpcUrl: string;
  /** Env var name that, when set, takes precedence over `defaultRpcUrl`. */
  rpcEnvVar?: string;
  /** Forge `--rpc-url <name>` alias, matches `[rpc_endpoints]` in foundry.toml. */
  forgeRpcAlias: string;
  /** Block explorer base URL, no trailing slash. Empty for local. */
  explorerUrl: string;
}

export const CHAINS: Record<SupportedChainId, ChainInfo> = {
  [LOCAL_CHAIN_ID]: {
    id: LOCAL_CHAIN_ID,
    name: "Anvil",
    defaultRpcUrl: "http://127.0.0.1:8545",
    forgeRpcAlias: "local",
    explorerUrl: "",
  },
  [BASE_SEPOLIA_CHAIN_ID]: {
    id: BASE_SEPOLIA_CHAIN_ID,
    name: "Base Sepolia",
    defaultRpcUrl: "https://sepolia.base.org",
    rpcEnvVar: "BASE_SEPOLIA_RPC_URL",
    forgeRpcAlias: "base-sepolia",
    explorerUrl: "https://sepolia.basescan.org",
  },
  [BASE_MAINNET_CHAIN_ID]: {
    id: BASE_MAINNET_CHAIN_ID,
    name: "Base",
    defaultRpcUrl: "https://mainnet.base.org",
    rpcEnvVar: "BASE_MAINNET_RPC_URL",
    forgeRpcAlias: "base-mainnet",
    explorerUrl: "https://basescan.org",
  },
};

/** Resolve the RPC URL for a chain, honoring the chain's env-var override. */
export function getRpcUrl(
  chainId: SupportedChainId,
  env: Record<string, string | undefined> = (typeof process !== "undefined"
    ? process.env
    : {}) as Record<string, string | undefined>,
): string {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unknown chain id: ${chainId}`);
  if (chain.rpcEnvVar) {
    const override = env[chain.rpcEnvVar];
    if (override && override.length > 0) return override;
  }
  return chain.defaultRpcUrl;
}

/** Pick a chain by its forge alias (e.g. "local", "base-sepolia"). */
export function chainByForgeAlias(alias: string): ChainInfo | undefined {
  return Object.values(CHAINS).find((c) => c.forgeRpcAlias === alias);
}

/** Heuristic: classify a raw RPC URL back to its chainId. */
export function chainIdFromRpcUrl(rpcUrl: string): SupportedChainId {
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") || rpcUrl.includes("0.0.0.0")) {
    return LOCAL_CHAIN_ID;
  }
  if (rpcUrl.includes("sepolia")) return BASE_SEPOLIA_CHAIN_ID;
  if (rpcUrl.includes("base.org") || rpcUrl.includes("base-mainnet")) return BASE_MAINNET_CHAIN_ID;
  throw new Error(`Cannot infer chainId from RPC URL: ${rpcUrl}`);
}
