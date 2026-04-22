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
