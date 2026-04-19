"use client";

import Link from "next/link";
import { formatUnits } from "viem";
import { useReadContract } from "wagmi";
import { useLockPositions, LockTier } from "@/lib/hooks";
import { useDeployedContract } from "@/lib/hooks/useDeployedContract";

const SHARES_UNIT = 1_000_000n; // 1 VOO share (6 decimals)

/**
 * Shows the connected user's LEAST-tier positions — terminal rehab receipts
 * whose principal has already been burned back to LPs. LEAST is a dead end;
 * the section doubles as a pointer to lossless mode, which is the only path
 * back to reward-earning locks.
 */
export function RehabLocks() {
  const { positions } = useLockPositions();
  const leastPositions = positions.filter(
    (p) => p.position.tier === LockTier.LEAST,
  );

  const vault = useDeployedContract("HouseVault");

  // Read current share price so we can label what each LEAST share would have
  // been worth at the moment the principal got burned.
  const { data: assetsPerShare } = useReadContract({
    address: vault?.address,
    abi: vault?.abi,
    functionName: "convertToAssets",
    args: [SHARES_UNIT],
    query: {
      enabled: !!vault?.address,
      refetchInterval: 10_000,
    },
  });

  if (leastPositions.length === 0) return null;

  const sharePrice =
    typeof assetsPerShare === "bigint"
      ? Number(formatUnits(assetsPerShare, 6))
      : 1.0;

  return (
    <section className="mx-auto max-w-3xl animate-fade-in-up">
      <div className="rounded-2xl border border-amber-500/10 bg-gradient-to-br from-amber-950/20 to-gray-900/50 p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl" role="img" aria-label="seedling">
              🌱
            </span>
            <h2 className="text-lg font-semibold text-white">Rehab Receipts</h2>
          </div>
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-400">
            Least tier
          </span>
        </div>

        <p className="mb-5 text-sm text-gray-400">
          These positions marked the end of a losing streak — principal has
          already been distributed to LPs. They don&apos;t earn fees. To rebuild
          a fee-earning lock, graduate a partial position to full (or catch a
          lossless win) — see the builder for details.
        </p>

        <div className="space-y-3">
          {leastPositions.map(({ id, position }) => {
            const principalFloat = Number(formatUnits(position.shares, 6));
            const valueAtBurn = (principalFloat * sharePrice).toFixed(2);
            const lockedAt = new Date(Number(position.lockedAt) * 1000);
            return (
              <div
                key={id.toString()}
                className="rounded-xl border border-white/5 bg-white/[0.02] p-4"
              >
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <div className="min-w-[120px]">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
                      Position #{id.toString()}
                    </p>
                    <p className="text-sm font-bold tabular-nums text-white">
                      {principalFloat.toFixed(2)} VOO{" "}
                      <span className="text-gray-500">(${valueAtBurn})</span>
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
                      Status
                    </p>
                    <p className="text-sm font-semibold text-gray-400">
                      Principal routed to LPs
                    </p>
                  </div>
                  <div className="ml-auto text-right">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
                      Created
                    </p>
                    <p className="text-sm font-semibold text-white">
                      {lockedAt.toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex justify-end">
          <Link
            href="/"
            className="rounded-lg bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-300 transition-colors hover:bg-amber-500/20"
          >
            Try a lossless parlay &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}
