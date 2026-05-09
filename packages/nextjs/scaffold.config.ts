import { defineChain } from "viem";
import * as chains from "viem/chains";

export type BaseConfig = {
  targetNetworks: readonly chains.Chain[];
  pollingInterval: number;
  alchemyApiKey: string;
  rpcOverrides?: Record<number, string>;
  walletConnectProjectId: string;
  burnerWalletMode: "localNetworksOnly" | "allNetworksOnly" | "allNetworks" | "disabled";
};

export type ScaffoldConfig = BaseConfig;

export const DEFAULT_ALCHEMY_API_KEY = "cR4WnXePioePZ5fFrnSiR";

// Strip whitespace + treat blank as unset. Trailing space in `.env` would
// otherwise bake into the Alchemy URL and cause every request to 401, then
// silently fall back to the public Base RPC (sepolia.base.org).
const cleanEnv = (raw: string | undefined): string | undefined => {
  const v = raw?.trim();
  return v ? v : undefined;
};

const ALCHEMY_KEY_RE = /^[A-Za-z0-9_-]+$/;
const rawAlchemyKey = cleanEnv(process.env.NEXT_PUBLIC_ALCHEMY_API_KEY);
if (rawAlchemyKey && !ALCHEMY_KEY_RE.test(rawAlchemyKey)) {
  console.warn(
    `[scaffold.config] NEXT_PUBLIC_ALCHEMY_API_KEY contains non-alphanumeric chars (len=${rawAlchemyKey.length}); ` +
      `every Alchemy request will fail and fall through to the public RPC. Re-check the .env value.`,
  );
}

const baseSepoliaRpcOverride = cleanEnv(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL);
const sepoliaRpcOverride = cleanEnv(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL);
const mainnetRpcOverride = cleanEnv(process.env.NEXT_PUBLIC_MAINNET_RPC_URL);
const baseMainnetRpcOverride = cleanEnv(process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL);

// Override viem's "Foundry" label so the wallet's network switcher reads
// "Anvil (Local)". Same chain id (31337) — wallets recognize the network by id.
const anvil = defineChain({
  ...chains.foundry,
  name: "Anvil (Local)",
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"] },
  },
});

const rpcOverrides: Record<number, string> = {};
if (baseSepoliaRpcOverride) rpcOverrides[chains.baseSepolia.id] = baseSepoliaRpcOverride;
if (sepoliaRpcOverride) rpcOverrides[chains.sepolia.id] = sepoliaRpcOverride;
if (mainnetRpcOverride) rpcOverrides[chains.mainnet.id] = mainnetRpcOverride;
if (baseMainnetRpcOverride) rpcOverrides[chains.base.id] = baseMainnetRpcOverride;

const scaffoldConfig = {
  // Order: local → testnets → mainnets. The first network in this list is
  // what RainbowKit defaults to when a freshly-connected wallet hasn't picked
  // a chain. ETH mainnet last is intentional — gas there is real.
  targetNetworks: [anvil, chains.sepolia, chains.baseSepolia, chains.base, chains.mainnet],
  pollingInterval: 3000,
  alchemyApiKey: rawAlchemyKey || DEFAULT_ALCHEMY_API_KEY,
  rpcOverrides,
  walletConnectProjectId:
    process.env.NEXT_PUBLIC_WC_PROJECT_ID ||
    process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ||
    "3a8170812b534d0ff9d794f19a901d64",
  // Burner wallets are useful for fast local iteration but a footgun in
  // production (browser-storage EOA = anyone with devtools access has the
  // key). "localNetworksOnly" gates on NEXT_PUBLIC_CHAIN_ID — burner shows
  // only when the deploy is pinned to anvil (31337); hidden on every
  // testnet/mainnet deploy.
  burnerWalletMode: "localNetworksOnly",
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
