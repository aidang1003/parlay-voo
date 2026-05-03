"use client";

import {FastForward} from "lucide-react";
import {setCompleted} from "@/lib/onboarding";

export function SkipOnboardingTile() {
  const onClick = () => {
    setCompleted();
    // Hard navigation rather than router.push — Next prefetches /parlay from
    // the header Link while the cookie is unset, caching middleware's
    // redirect-to-/ response. router.push would replay the cached redirect.
    window.location.href = "/parlay";
  };

  return (
    <div className="glass-card flex items-center gap-4 rounded-2xl border border-white/5 p-5 transition-colors sm:gap-6 sm:p-6">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-white/15 text-gray-400">
        <FastForward className="h-4 w-4" />
      </div>

      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-bold text-white sm:text-base">Skip onboarding</h3>
        <p className="mt-0.5 text-xs text-gray-400 sm:text-sm">
          Jump straight to the app. Without a wallet, gas, and USDC you can browse markets
          and view tickets, but you won&apos;t be able to place a bet until the steps above
          are complete.
        </p>
      </div>

      <div className="flex-shrink-0">
        <button
          onClick={onClick}
          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-bold text-gray-300 transition-colors hover:bg-white/10 hover:text-white sm:px-5 sm:py-2.5 sm:text-sm"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
