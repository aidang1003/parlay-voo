"use client";

import { ReactNode, useEffect } from "react";
import { WagmiProvider } from "wagmi";
import { reconnect } from "wagmi/actions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectKitProvider } from "connectkit";
import { config } from "@/lib/wagmi";
import { DebugRpcCounter } from "./DebugRpcCounter";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchIntervalInBackground: false,
    },
  },
});

// Rabby's MV3 service worker gets killed by Chrome after ~30s of tab
// inactivity and re-injects a fresh window.ethereum on wake. Wagmi's cached
// provider reference is stale by then, so the React store shows disconnected
// even though the wallet still trusts the site. Re-running reconnect() on
// tab-visible / window-focus rebinds to the live provider silently.
function WagmiReconnect() {
  useEffect(() => {
    const kick = () => {
      if (document.visibilityState === "visible") void reconnect(config);
    };
    void reconnect(config);
    document.addEventListener("visibilitychange", kick);
    window.addEventListener("focus", kick);
    return () => {
      document.removeEventListener("visibilitychange", kick);
      window.removeEventListener("focus", kick);
    };
  }, []);
  return null;
}

export default function ProvidersInner({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider
          theme="midnight"
          customTheme={{
            "--ck-font-family": "inherit",
          }}
        >
          <WagmiReconnect />
          {children}
          <DebugRpcCounter />
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
