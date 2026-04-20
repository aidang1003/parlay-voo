import { createConfig, http } from "wagmi";
import { baseSepolia, foundry, mainnet } from "wagmi/chains";
import { fallback, type Transport } from "viem";
import { getDefaultConfig } from "connectkit";
import { CHAINS, BASE_SEPOLIA_CHAIN_ID, LOCAL_CHAIN_ID } from "@parlayvoo/shared";

const primarySepoliaRpc = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL;

// Wraps a transport to record every JSON-RPC request on window.__rpcCalls
// so the DebugRpcCounter overlay (?debug=1) can surface call counts.
const counted = (inner: Transport): Transport =>
  ((args: Parameters<Transport>[0]) => {
    const t = inner(args);
    const orig = t.request;
    const request: typeof orig = async (params, opts) => {
      if (typeof window !== "undefined") {
        const w = window as unknown as { __rpcCalls?: { method: string; ts: number }[] };
        if (!w.__rpcCalls) w.__rpcCalls = [];
        w.__rpcCalls.push({ method: (params as { method: string }).method, ts: Date.now() });
        if (w.__rpcCalls.length > 5000) w.__rpcCalls.splice(0, w.__rpcCalls.length - 5000);
      }
      return orig(params, opts);
    };
    return { ...t, request };
  }) as Transport;

export const config = createConfig(
  getDefaultConfig({
    appName: "ParlayVoo",
    walletConnectProjectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "",
    chains: [baseSepolia, foundry],
    transports: {
      [baseSepolia.id]: primarySepoliaRpc
        ? counted(fallback([http(primarySepoliaRpc), http(CHAINS[BASE_SEPOLIA_CHAIN_ID].defaultRpcUrl)]))
        : counted(http(CHAINS[BASE_SEPOLIA_CHAIN_ID].defaultRpcUrl)),
      [foundry.id]: counted(http(CHAINS[LOCAL_CHAIN_ID].defaultRpcUrl)),
      // ConnectKit uses an Ethereum L1 client for ENS resolution; without an
      // explicit transport it falls back to eth.merkle.io, which blocks CORS.
      [mainnet.id]: http("https://cloudflare-eth.com"),
    },
  }),
);
