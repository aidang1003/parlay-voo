"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppProgressBar as ProgressBar } from "next-nprogress-bar";
import { Toaster } from "react-hot-toast";
import { WagmiProvider } from "wagmi";
import { ChainGuard } from "~~/components/ChainGuard";
import { FTUEProvider, FTUESpotlight } from "~~/components/FTUESpotlight";
import { Header } from "~~/components/Header";
import { TestnetBanner } from "~~/components/TestnetBanner";
import { BlockieAvatar } from "~~/components/scaffold-eth";
import { wagmiConfig } from "~~/services/web3/wagmiConfig";

// ChatPanel pulls in @ai-sdk/react which evaluates client-only globals at module
// init. SSR'ing it inside the providers tree triggers `indexedDB` errors during
// static page generation, so defer it to a client-only chunk.
const ChatPanel = dynamic(() => import("~~/components/ChatPanel").then(m => ({ default: m.ChatPanel })), {
  ssr: false,
});
const DebugRpcCounter = dynamic(
  () => import("~~/components/DebugRpcCounter").then(m => ({ default: m.DebugRpcCounter })),
  { ssr: false },
);

const ScaffoldEthApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <FTUEProvider>
      <div className="relative z-10 flex flex-col min-h-screen">
        <div className="pointer-events-none fixed inset-0 overflow-hidden -z-10" aria-hidden="true">
          <div className="absolute -left-60 -top-60 h-[700px] w-[700px] rounded-full bg-brand-pink/[0.07] blur-[150px]" />
          <div className="absolute -right-60 top-1/4 h-[600px] w-[600px] rounded-full bg-brand-purple/[0.06] blur-[150px]" />
          <div className="absolute -bottom-60 left-1/3 h-[500px] w-[500px] rounded-full bg-brand-purple-1/[0.04] blur-[130px]" />
        </div>
        <Header />
        <ChainGuard />
        <TestnetBanner />
        <FTUESpotlight />
        <main className="relative flex flex-1 flex-col mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">{children}</main>
      </div>
      <ChatPanel />
      <DebugRpcCounter />
      <Toaster />
    </FTUEProvider>
  );
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchIntervalInBackground: false,
    },
  },
});

export const ScaffoldEthAppWithProviders = ({ children }: { children: React.ReactNode }) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider avatar={BlockieAvatar} theme={mounted ? darkTheme() : darkTheme()}>
          <ProgressBar height="3px" color="#ff1a8c" />
          <ScaffoldEthApp>{children}</ScaffoldEthApp>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
};
