"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useAccount, useDisconnect } from "wagmi";
import { useIsAdmin } from "~~/lib/hooks/debug";

// Allowlist source = tbadminwallet (DB). UX-grade gate — server routes are
// still gated by chain + on-chain keys. See docs/changes/C_USER_FEEDBACK.md.
export function AdminGate({ children }: { children: React.ReactNode }) {
  const { isConnected, address } = useAccount();
  const { disconnect } = useDisconnect();
  const { isAdmin, isLoading } = useIsAdmin();

  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <span className="loading loading-spinner loading-md text-primary" />
      </div>
    );
  }

  if (isAdmin) return <>{children}</>;

  return (
    <div className="mx-auto max-w-xl py-16">
      <div className="rounded-2xl border border-white/5 bg-gray-900/40 p-8 text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border border-brand-pink/30 bg-brand-pink/10">
          {isConnected ? (
            <ShieldAlert className="h-6 w-6 text-brand-pink" />
          ) : (
            <ShieldCheck className="h-6 w-6 text-brand-pink" />
          )}
        </div>
        <h1 className="text-xl font-bold text-white">
          {isConnected ? "Wallet not authorized" : "Connect an admin wallet"}
        </h1>
        <p className="mt-2 text-sm text-gray-400">
          {isConnected ? (
            <>
              <span className="font-mono text-xs text-gray-300">{shortAddr(address)}</span> isn&apos;t on the admin
              allowlist. Disconnect and reconnect with an authorized wallet to continue.
            </>
          ) : (
            <>This page is restricted to wallets in the admin allowlist.</>
          )}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          {isConnected ? (
            <button onClick={() => disconnect()} className="btn btn-sm btn-outline">
              Disconnect wallet
            </button>
          ) : (
            <ConnectButton accountStatus="address" chainStatus="full" showBalance={false} />
          )}
        </div>
      </div>
    </div>
  );
}

function shortAddr(addr: string | undefined): string {
  if (!addr || addr.length < 10) return addr ?? "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
