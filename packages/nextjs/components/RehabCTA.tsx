"use client";

import Link from "next/link";
import { useCreditBalance, useRehabClaimable } from "~~/lib/hooks";
import { formatUSDC } from "~~/lib/utils";

const BPS = 10_000n;

interface RehabCTAProps {
  /** Original ticket stake in USDC (6 decimals). Shown on the card for context. */
  stake: bigint;
}

/**
 * "Silver lining" card shown on lost tickets. Nudges the user toward the
 * rehab claim flow: lock the loss into the pool and mint bet-only credit.
 */
export function RehabCTA({ stake }: RehabCTAProps) {
  const { credit } = useCreditBalance();
  const { claimable, projectedAprBps } = useRehabClaimable();

  const creditFmt = formatUSDC(credit && credit > 0n ? credit : 0n);
  const stakeFmt = formatUSDC(stake > 0n ? stake : 0n);

  const preview = claimable && projectedAprBps ? (claimable * projectedAprBps) / BPS : 0n;
  const previewFmt = formatUSDC(preview);
  const claimableFmt = formatUSDC(claimable ?? 0n);
  const hasClaimable = !!claimable && claimable > 0n;

  return (
    <div className="animate-fade-in-up rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-950/40 to-yellow-950/20 p-6">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-2xl" role="img" aria-label="shield">
          🛡️
        </span>
        <h3 className="text-lg font-bold text-amber-300">Your ticket crashed. Turn it into credit.</h3>
      </div>

      <p className="mb-4 text-sm text-amber-200/70">
        You staked <span className="font-semibold text-amber-200">${stakeFmt}</span>. Losses go into the VOO pool and
        accrue to a per-wallet balance. Lock that balance up for a duration of your choosing and the vault mints you{" "}
        <span className="font-semibold text-amber-200">bet-only credit</span> worth one year of yield on the principal.
        Use the credit on lossless parlays — wins rehab into more locked VOO, losses just burn the credit.
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3 rounded-xl border border-amber-500/10 bg-amber-900/20 px-4 py-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-amber-400/60">Unclaimed losses</p>
          <p className="text-lg font-bold tabular-nums text-amber-300">${claimableFmt}</p>
          {hasClaimable && preview > 0n && (
            <p className="mt-0.5 text-[10px] text-amber-400/60">≈ ${previewFmt} credit when claimed</p>
          )}
        </div>
        <div className="text-right">
          <p className="text-[10px] font-medium uppercase tracking-wider text-amber-400/60">Current credit balance</p>
          <p className="text-lg font-bold tabular-nums text-amber-300">${creditFmt}</p>
        </div>
      </div>

      <div className="flex gap-3">
        <Link
          href="/parlay"
          className="flex-1 rounded-xl border border-amber-500/30 bg-amber-500/10 py-2.5 text-center text-sm font-semibold text-amber-300 transition-colors hover:bg-amber-500/20"
        >
          Place a Lossless Parlay
        </Link>
        <Link
          href="/rehab/claim"
          className={`flex-1 rounded-xl py-2.5 text-center text-sm font-semibold text-white transition-opacity ${
            hasClaimable
              ? "bg-gradient-to-r from-amber-600 to-yellow-600 hover:opacity-90"
              : "cursor-not-allowed bg-gradient-to-r from-amber-800/50 to-yellow-800/50 opacity-60"
          }`}
          aria-disabled={!hasClaimable}
        >
          Claim & Lock Loss
        </Link>
      </div>
    </div>
  );
}
