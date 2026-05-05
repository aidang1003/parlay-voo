import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  baseAccount,
  ledgerWallet,
  metaMaskWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { rainbowkitBurnerWallet } from "burner-connector";
import scaffoldConfig, { type ScaffoldConfig } from "~~/scaffold.config";
import { LOCAL_CHAIN_ID } from "~~/utils/parlay";

const { burnerWalletMode } = scaffoldConfig as ScaffoldConfig;

// Build-time signal: which chain this deployment is pinned to. Local dev sets
// this to 31337 (anvil); preview/prod set it to 84532/8453/etc.
const pinnedChainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || LOCAL_CHAIN_ID);
const isLocalDeployment = pinnedChainId === LOCAL_CHAIN_ID;

const showBurnerWallet = (() => {
  if (burnerWalletMode === "disabled") return false;
  if (burnerWalletMode === "allNetworks" || burnerWalletMode === "allNetworksOnly") return true;
  return isLocalDeployment;
})();

const wallets = [
  metaMaskWallet,
  walletConnectWallet,
  ledgerWallet,
  baseAccount,
  rainbowWallet,
  safeWallet,
  ...(showBurnerWallet ? [rainbowkitBurnerWallet] : []),
];

/**
 * wagmi connectors for the wagmi context
 */
export const wagmiConnectors = () => {
  // Only create connectors on client-side to avoid SSR issues
  // TODO: update when https://github.com/rainbow-me/rainbowkit/issues/2476 is resolved
  if (typeof window === "undefined") {
    return [];
  }

  return connectorsForWallets(
    [
      {
        groupName: "Supported Wallets",
        wallets,
      },
    ],

    {
      appName: "scaffold-eth-2",
      projectId: scaffoldConfig.walletConnectProjectId,
    },
  );
};
