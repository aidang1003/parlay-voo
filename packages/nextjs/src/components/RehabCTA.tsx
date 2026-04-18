"use client";

import Link from "next/link";
import { formatUnits } from "viem";
import { useCreditBalance } from "@/lib/hooks";

interface RehabCTAProps {
  /** Original ticket stake in USDC (6 decimals). Kept for caller compatibility. */
  stake: bigint;
}

/**
 * "Silver lining" card shown on lost tickets. Points losers at lossless mode:
 * if they graduate a PARTIAL position to FULL, the vault issues promo credit
 * equal to 6% APR on their locked principal, which can then be staked into
 * new parlays with no risk of losing principal — only the credit burns.
 */
export function RehabCTA({ stake }: RehabCTAProps) {
  const { credit } = useCreditBalance();
  const creditFmt =
    credit && credit > 0n
      ? Number(formatUnits(credit, 6)).toFixed(2)
      : "0.00";
  const stakeFmt =
    stake > 0n ? Number(formatUnits(stake, 6)).toFixed(2) : "0.00";

  return (
    <div className="animate-fade-in-up rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-950/40 to-yellow-950/20 p-6">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-2xl" role="img" aria-label="shield">
          🛡️
        </span>
        <h3 className="text-lg font-bold text-amber-300">
          Your ticket crashed. But the house is hiring.
        </h3>
      </div>

      <p className="mb-4 text-sm text-amber-200/70">
        You staked{" "}
        <span className="font-semibold text-amber-200">${stakeFmt}</span>. Bring
        your next bet back with{" "}
        <span className="font-semibold text-amber-200">lossless mode</span>:
        graduate a partial lock to a 2-year full lock, the vault mints you promo
        credit (~6% APR on principal), and you parlay the credit instead of
        USDC. Wins rehab into more locked VOO. Losses just burn the credit.
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3 rounded-xl border border-amber-500/10 bg-amber-900/20 px-4 py-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-amber-400/60">
            Your promo credit
          </p>
          <p className="text-lg font-bold tabular-nums text-amber-300">
            ${creditFmt}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-medium uppercase tracking-wider text-amber-400/60">
            Graduate duration
          </p>
          <p className="text-sm font-semibold text-amber-300">2 years (min)</p>
        </div>
      </div>

      <div className="flex gap-3">
        <Link
          href="/vault"
          className="flex-1 rounded-xl border border-amber-500/30 bg-amber-500/10 py-2.5 text-center text-sm font-semibold text-amber-300 transition-colors hover:bg-amber-500/20"
        >
          Graduate a Lock
        </Link>
        <Link
          href="/"
          className="flex-1 rounded-xl bg-gradient-to-r from-amber-600 to-yellow-600 py-2.5 text-center text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          Place a Lossless Parlay
        </Link>
      </div>
    </div>
  );
}
