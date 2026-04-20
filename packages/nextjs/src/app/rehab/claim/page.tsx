"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useRehabClaimable, useClaimRehab } from "@/lib/hooks";
import { formatUSDC } from "@/lib/utils";

const SECS_PER_DAY = 86_400n;
const SECS_PER_YEAR = 365n * SECS_PER_DAY;
const BPS = 10_000n;

type Preset = { label: string; years: number };

const PRESETS: Preset[] = [
  { label: "1 year", years: 1 },
  { label: "2 years", years: 2 },
  { label: "3 years", years: 3 },
  { label: "5 years", years: 5 },
  { label: "10 years", years: 10 },
];

const fmtUsdc = (n: bigint | undefined): string => formatUSDC(n, { placeholder: "0.00" });

export default function RehabClaimPage() {
  const { isConnected } = useAccount();
  const { claimable, projectedAprBps, minDuration, isLoading, refetch } = useRehabClaimable();
  const claim = useClaimRehab();

  // Default to 2 years — doubles the minimum and reads as a meaningful commitment.
  const [years, setYears] = useState<number>(2);

  const durationSecs = useMemo(() => BigInt(years) * SECS_PER_YEAR, [years]);

  const minYears = useMemo(() => {
    if (!minDuration) return 1;
    return Math.max(1, Math.ceil(Number(minDuration / SECS_PER_YEAR)));
  }, [minDuration]);

  const creditPreview = useMemo(() => {
    if (!claimable || !projectedAprBps) return 0n;
    return (claimable * projectedAprBps) / BPS;
  }, [claimable, projectedAprBps]);

  const aprPct = projectedAprBps ? Number(projectedAprBps) / 100 : undefined;

  const canClaim =
    isConnected && !!claimable && claimable > 0n && !!minDuration && durationSecs >= minDuration;

  async function handleClaim() {
    if (!canClaim) return;
    const ok = await claim.claim(durationSecs);
    if (ok) {
      refetch();
    }
  }

  if (!isConnected) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-3xl font-black text-white">Rehab Claim</h1>
        <p className="mt-3 text-gray-400">Connect your wallet to see your claimable losses.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 pb-12">
      <section>
        <Link
          href="/tickets"
          className="text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-300"
        >
          ← Back to tickets
        </Link>
        <h1 className="mt-2 text-3xl font-black text-white">
          Claim your <span className="gradient-text">rehab credit</span>
        </h1>
        <p className="mt-2 text-gray-400">
          When a parlay loses, your stake goes into the pool and accrues to a per-wallet
          balance. Lock that balance up and the vault mints you bet-only credit worth one
          year of yield on the principal — regardless of how long you lock for.
        </p>
      </section>

      {/* Claimable card */}
      <section className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-950/40 to-yellow-950/20 p-6">
        <p className="text-[10px] font-medium uppercase tracking-wider text-amber-400/70">
          Unclaimed losses
        </p>
        <p className="mt-1 text-4xl font-black tabular-nums text-amber-200">
          ${fmtUsdc(claimable)}
        </p>
        <p className="mt-2 text-sm text-amber-200/60">
          {isLoading
            ? "Loading…"
            : claimable && claimable > 0n
              ? "Will be converted into a locked position in the VOO pool."
              : "No losses to claim right now."}
        </p>
      </section>

      {/* Duration picker */}
      <section className="space-y-4 rounded-2xl border border-white/5 bg-gray-900/50 p-6">
        <div>
          <h2 className="text-lg font-bold text-white">Pick your lockup</h2>
          <p className="mt-1 text-sm text-gray-400">
            Longer locks don&apos;t earn more credit — they demonstrate conviction and keep
            your principal deeper in the pool. Minimum lock is{" "}
            <span className="font-semibold text-white">{minYears} year{minYears === 1 ? "" : "s"}</span>.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {PRESETS.map((p) => {
            const disabled = p.years < minYears;
            const active = years === p.years;
            return (
              <button
                key={p.years}
                disabled={disabled}
                onClick={() => setYears(p.years)}
                className={`rounded-xl px-3 py-2.5 text-sm font-semibold transition-all ${
                  active
                    ? "gradient-bg text-white shadow-lg"
                    : disabled
                      ? "cursor-not-allowed border border-white/5 bg-white/0 text-gray-600"
                      : "border border-white/10 bg-white/5 text-gray-300 hover:bg-white/10"
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 pt-2">
          <label className="text-xs font-medium uppercase tracking-wider text-gray-500">
            Custom (years)
          </label>
          <input
            type="number"
            min={minYears}
            max={50}
            value={years}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) setYears(v);
            }}
            className="w-24 rounded-lg border border-white/10 bg-gray-900 px-3 py-1.5 text-sm text-white focus:border-brand-pink focus:outline-none"
          />
        </div>
      </section>

      {/* Preview */}
      <section className="grid gap-4 rounded-2xl border border-white/5 bg-gray-900/30 p-6 sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
            You lock
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-white">
            ${fmtUsdc(claimable)}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            for {years} year{years === 1 ? "" : "s"} in the VOO pool
          </p>
        </div>
        <div className="sm:text-right">
          <p className="text-[10px] font-medium uppercase tracking-wider text-amber-400/70">
            You receive (bet-only credit)
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-amber-200">
            ${fmtUsdc(creditPreview)}
          </p>
          <p className="mt-1 text-xs text-amber-200/50">
            {aprPct !== undefined ? `${aprPct}% APR × 1 year of principal` : "12 months of projected yield"}
          </p>
        </div>
      </section>

      {/* Info */}
      <section className="space-y-3 rounded-2xl border border-white/5 bg-gray-950/60 p-6 text-sm text-gray-400">
        <h3 className="text-sm font-bold uppercase tracking-wider text-gray-300">How this works</h3>
        <ul className="space-y-2 pl-1">
          <li>
            <span className="font-semibold text-white">Your losses stay in the pool.</span>{" "}
            They back fresh VOO shares which are locked on your behalf — you don&apos;t
            withdraw USDC here.
          </li>
          <li>
            <span className="font-semibold text-white">Credit is bet-only.</span>{" "}
            Use it on lossless parlays. Wins pay out as PARTIAL-tier locks; losses just burn
            the credit — your locked principal is untouched.
          </li>
          <li>
            <span className="font-semibold text-white">Credit size is fixed.</span>{" "}
            Always {aprPct ?? 6}% of your claimed amount, regardless of lockup length.
            Longer locks only affect when your principal becomes spendable again.
          </li>
          <li>
            <span className="font-semibold text-white">No early exit.</span>{" "}
            Rehab locks can&apos;t be unwound before expiry. When they do expire, the
            principal returns to LPs — credit you&apos;ve already earned is yours to keep.
          </li>
        </ul>
      </section>

      {/* CTA */}
      <section className="sticky bottom-4 z-10">
        <button
          onClick={handleClaim}
          disabled={!canClaim || claim.isPending || claim.isConfirming}
          className="w-full rounded-2xl bg-gradient-to-r from-amber-600 to-yellow-600 px-6 py-4 text-base font-bold text-white shadow-lg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {claim.isConfirming
            ? "Confirming…"
            : claim.isPending
              ? "Preparing…"
              : claim.isSuccess
                ? "Claimed ✓"
                : canClaim
                  ? `Lock $${fmtUsdc(claimable)} & claim $${fmtUsdc(creditPreview)} credit`
                  : !claimable || claimable === 0n
                    ? "Nothing to claim"
                    : "Pick a valid duration"}
        </button>
        {claim.error && (
          <p className="mt-2 text-center text-sm text-neon-red">
            {claim.error.message.slice(0, 200)}
          </p>
        )}
      </section>
    </div>
  );
}
