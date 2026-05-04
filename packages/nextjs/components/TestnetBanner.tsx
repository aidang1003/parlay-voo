"use client";

import Link from "next/link";
import { useIsTestnet } from "~~/lib/hooks/debug";

export function TestnetBanner() {
  const isTestnet = useIsTestnet();
  if (!isTestnet) return null;

  return (
    <div data-testid="testnet-banner" className="relative mx-auto max-w-7xl px-4 sm:px-6">
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-brand-pink/20 bg-gradient-to-r from-brand-pink/10 via-brand-purple/10 to-brand-pink/10 px-4 py-2 text-sm text-gray-300">
        <span className="flex-shrink-0 rounded-full bg-brand-pink/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-pink">
          Testnet
        </span>
        <p className="flex-1">You&apos;re connected to testnet — admin tooling lives on the debug page.</p>
        <Link
          href="/admin/debug"
          className="flex-shrink-0 rounded-lg border border-brand-pink/30 px-3 py-1 text-xs font-bold text-brand-pink transition-colors hover:bg-brand-pink/10"
        >
          Open debug page
        </Link>
      </div>
    </div>
  );
}
