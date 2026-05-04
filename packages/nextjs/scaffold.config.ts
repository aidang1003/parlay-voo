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

const baseSepoliaRpcOverride = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL;
const sepoliaRpcOverride = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
const mainnetRpcOverride = process.env.NEXT_PUBLIC_MAINNET_RPC_URL;
const baseMainnetRpcOverride = process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL;

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
  alchemyApiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || DEFAULT_ALCHEMY_API_KEY,
  rpcOverrides,
  walletConnectProjectId:
    process.env.NEXT_PUBLIC_WC_PROJECT_ID ||
    process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ||
    "3a8170812b534d0ff9d794f19a901d64",
  // "allNetworks" so the in-browser burner wallet shows up on Base Sepolia too
  // (handy for one-click testing without configuring Anvil in MetaMask/Rabby).
  burnerWalletMode: "allNetworks",
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
