"use client";

import Link from "next/link";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { useRehabClaimable } from "@/lib/hooks";

const BPS = 10_000n;

/**
 * Top-of-page banner that appears whenever the connected wallet has an
 * unclaimed rehab balance (one or more lost tickets whose stake accrued to
 * `rehabClaimable`). Points the user at `/rehab/claim` where they pick a
 * lockup duration and mint advance credit.
 */
export function RehabClaimBanner() {
  const { isConnected } = useAccount();
  const { claimable, projectedAprBps } = useRehabClaimable();

  if (!isConnected) return null;
  if (!claimable || claimable === 0n) return null;

  const claimableFmt = Number(formatUnits(claimable, 6)).toFixed(2);
  const credit = projectedAprBps ? (claimable * projectedAprBps) / BPS : 0n;
  const creditFmt = Number(formatUnits(credit, 6)).toFixed(2);

  return (
    <div className="animate-fade-in-up rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-950/50 to-yellow-950/30 p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="text-2xl" role="img" aria-label="shield">
            🛡️
          </span>
          <div>
            <p className="text-base font-bold text-amber-200">
              You have ${claimableFmt} in unclaimed losses.
            </p>
            <p className="mt-1 text-sm text-amber-200/70">
              Lock your losses to unlock{" "}
              <span className="font-semibold text-amber-200">
                ${creditFmt}
              </span>{" "}
              in bet-only credit. You pick the lockup duration.
            </p>
          </div>
        </div>
        <Link
          href="/rehab/claim"
          className="shrink-0 rounded-xl bg-gradient-to-r from-amber-600 to-yellow-600 px-5 py-2.5 text-center text-sm font-bold text-white transition-opacity hover:opacity-90"
        >
          Claim & lock →
        </Link>
      </div>
    </div>
  );
}
