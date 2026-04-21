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

// @bug R-6: after a ticket purchase + client-side navigation to /tickets, wagmi
// was dropping the connector reference even though Rabby still reported the
// site as connected — which left the user stuck (Rabby treats the site as
// already connected, so ConnectKit's "Connect" flow is a no-op). Calling
// reconnect() once on mount rehydrates the stored connection and keeps the
// account state stable across navigations.
function WagmiReconnect() {
  useEffect(() => {
    void reconnect(config);
  }, []);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
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
