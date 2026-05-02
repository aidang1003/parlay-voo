"use client";

import { useMemo, useState } from "react";
import { parseUnits, formatUnits } from "viem";
import { useMintTestUSDC, useUSDCBalance } from "@/lib/hooks";
import { useIsTestnet, useOpenLegs, useRecentResolutions, type OpenLeg } from "@/lib/hooks/debug";
import { formatUSDC } from "@/lib/utils";

type ResolveStatus = 1 | 2 | 3;

const MIN_MINT = 1;
const MAX_MINT = 1_000_000;
const DEFAULT_MINT = 1_000;

export default function AdminDebugPage() {
  const isTestnet = useIsTestnet();
  if (!isTestnet) {
    return (
      <div className="py-16 text-center text-gray-500">
        Disabled on this chain.
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl font-black text-white">
          Admin · <span className="gradient-text">Debug</span>
        </h1>
        <p className="mt-2 text-gray-400">
          Testnet-only tooling. Mint MockUSDC, poke the Polymarket DB, resolve
          legs manually.
        </p>
      </header>

      <MintSection />
      <DatabaseSection />
      <LegResolverSection />
      <RecentResolutionsSection />
    </div>
  );
}

// ── Mint ──────────────────────────────────────────────────────────────────

function MintSection() {
  const { balance, refetch } = useUSDCBalance();
  const { mint, isPending, isConfirming, isSuccess, error } = useMintTestUSDC();
  const [amount, setAmount] = useState(DEFAULT_MINT);

  const buttonLabel = isPending
    ? "Signing…"
    : isConfirming
      ? "Minting…"
      : isSuccess
        ? "Minted!"
        : `Mint ${amount.toLocaleString()} USDC`;

  async function handleMint() {
    await mint(parseUnits(String(amount), 6));
    refetch();
  }

  return (
    <Section title="Mint MockUSDC">
      <div className="flex items-center gap-4">
        <input
          type="range"
          min={MIN_MINT}
          max={MAX_MINT}
          step={MIN_MINT}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          className="flex-1"
          aria-label="Mint amount"
        />
        <input
          type="number"
          min={MIN_MINT}
          max={MAX_MINT}
          value={amount}
          onChange={(e) => setAmount(clamp(Number(e.target.value), MIN_MINT, MAX_MINT))}
          className="w-28 rounded-lg border border-white/10 bg-gray-900/50 px-3 py-1.5 text-right font-mono text-sm text-gray-200"
        />
      </div>
      <div className="mt-4 flex items-center justify-between">
        <div className="text-xs text-gray-500">
          Balance:{" "}
          <span className="font-mono text-gray-300">
            {balance !== undefined ? Number(formatUnits(balance, 6)).toLocaleString() : "…"} USDC
          </span>
        </div>
        <button
          onClick={handleMint}
          disabled={isPending || isConfirming}
          className="rounded-lg border border-brand-pink/40 bg-brand-pink/10 px-4 py-2 text-sm font-semibold text-brand-pink transition-colors hover:bg-brand-pink/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {buttonLabel}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-neon-red">{error}</p>}
    </Section>
  );
}

// ── Database ──────────────────────────────────────────────────────────────

function DatabaseSection() {
  return (
    <Section title="Database">
      <p className="mb-4 text-xs text-gray-500">
        Proxies attach CRON_SECRET server-side so Vercel-hosted testnets can
        still trigger these without the token reaching the browser.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <DbButton label="Initialize DB" url="/api/admin/db-init" />
        <DbButton label="Sync Polymarket" url="/api/admin/sync" />
      </div>
    </Section>
  );
}

function DbButton({ label, url }: { label: string; url: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [response, setResponse] = useState<string | null>(null);

  async function run() {
    setState("loading");
    setResponse(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const body = await res.text();
      setResponse(prettyJson(body));
      setState(res.ok ? "done" : "error");
    } catch (e) {
      setResponse(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  return (
    <div className="rounded-lg border border-white/5 bg-gray-900/40 p-4">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-gray-200">{label}</span>
        <button
          onClick={run}
          disabled={state === "loading"}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60"
        >
          {state === "loading" ? "Running…" : "Run"}
        </button>
      </div>
      {response && (
        <pre
          className={`mt-3 max-h-60 overflow-auto rounded bg-black/40 p-3 text-[11px] ${
            state === "error" ? "text-neon-red" : "text-gray-300"
          }`}
        >
          {response}
        </pre>
      )}
    </div>
  );
}

// ── Leg resolver ──────────────────────────────────────────────────────────

interface RowState {
  pending: boolean;
  result?: string;
  error?: string;
}

function LegResolverSection() {
  const { legs, isLoading, refetch } = useOpenLegs();
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  // Lock every resolve button while any row is in flight. Concurrent POSTs
  // land in separate Vercel lambdas, all reading the same pending nonce from
  // Alchemy, which races into "replacement transaction underpriced".
  const anyPending = Object.values(rowState).some((s) => s.pending);

  async function resolve(leg: OpenLeg, status: ResolveStatus) {
    const key = leg.legId.toString();
    setRowState((s) => ({ ...s, [key]: { pending: true } }));
    try {
      const res = await fetch("/api/admin/resolve-leg", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ legId: leg.legId.toString(), status }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        setRowState((s) => ({
          ...s,
          [key]: {
            pending: false,
            error: body.stderr || body.error || `HTTP ${res.status}`,
          },
        }));
        return;
      }
      setRowState((s) => ({ ...s, [key]: { pending: false, result: "Resolved" } }));
      refetch();
    } catch (e) {
      setRowState((s) => ({
        ...s,
        [key]: { pending: false, error: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  return (
    <Section
      title="Leg Resolver"
      action={
        <button
          onClick={refetch}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          Refresh
        </button>
      }
    >
      <p className="mb-4 text-xs text-gray-500">
        Every unresolved leg referenced by any ticket. Clicking a button signs{" "}
        <code className="text-gray-300">AdminOracleAdapter.resolve()</code>{" "}
        server-side with <code className="text-gray-300">DEPLOYER_PRIVATE_KEY</code>.
        YES pays YES bettors, NO pays NO bettors, VOID refunds the leg.
      </p>

      {isLoading && (
        <div className="flex min-h-[20vh] items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-pink border-t-transparent" />
        </div>
      )}

      {!isLoading && legs.length === 0 && (
        <div className="py-10 text-center text-gray-500">No open legs on tickets.</div>
      )}

      {!isLoading && legs.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-white/5 bg-gray-900/40">
          <table className="w-full text-sm">
            <thead className="border-b border-white/5 bg-white/5 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3">Leg #</th>
                <th className="px-4 py-3">Source ref</th>
                <th className="px-4 py-3">Question</th>
                <th className="px-4 py-3 text-right">YES</th>
                <th className="px-4 py-3 text-right">NO</th>
                <th className="px-4 py-3 text-right" title="Active tickets that bet YES vs NO on this leg, with summed stake.">Positions</th>
                <th className="px-4 py-3">Cutoff</th>
                <th className="px-4 py-3 text-right">Resolve</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {legs.map((leg) => {
                const key = leg.legId.toString();
                const state = rowState[key];
                return (
                  <tr key={key} className="align-top text-gray-300">
                    <td className="px-4 py-3 font-mono text-gray-500">#{key}</td>
                    <td className="px-4 py-3 max-w-[180px] truncate font-mono text-xs">{leg.sourceRef}</td>
                    <td className="px-4 py-3 max-w-[320px]">
                      <div className="whitespace-normal">{leg.question}</div>
                      {state?.error && (
                        <div className="mt-1 text-[11px] text-neon-red line-clamp-2">{state.error}</div>
                      )}
                      {state?.result && (
                        <div className="mt-1 text-[11px] text-emerald-400">{state.result}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-emerald-300">{fmtPct(leg.yesProbabilityPPM)}</td>
                    <td className="px-4 py-3 text-right font-mono text-red-300">
                      {fmtPct(
                        leg.noProbabilityPPM ??
                          (leg.yesProbabilityPPM != null ? 1_000_000 - leg.yesProbabilityPPM : null),
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs leading-tight">
                      <div className="text-emerald-300">
                        {leg.yesCount} <span className="text-gray-500">·</span>{" "}
                        ${fmtStake(leg.yesStake)}
                      </div>
                      <div className="text-red-300">
                        {leg.noCount} <span className="text-gray-500">·</span>{" "}
                        ${fmtStake(leg.noStake)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{fmtTime(Number(leg.cutoffTime))}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <ResolveButton onClick={() => resolve(leg, 1)} disabled={anyPending} tone="yes">
                          YES
                        </ResolveButton>
                        <ResolveButton onClick={() => resolve(leg, 2)} disabled={anyPending} tone="no">
                          NO
                        </ResolveButton>
                        <ResolveButton onClick={() => resolve(leg, 3)} disabled={anyPending} tone="void">
                          VOID
                        </ResolveButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ── Recently resolved ────────────────────────────────────────────────────

function RecentResolutionsSection() {
  const { rows, isLoading, refetch } = useRecentResolutions({ limit: 20 });

  return (
    <Section
      title="Recently Resolved"
      action={
        <button
          onClick={refetch}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          Refresh
        </button>
      }
    >
      <p className="mb-4 text-xs text-gray-500">
        Audit trail of the last 20 leg resolutions, newest first. Once resolved
        on-chain, a leg is immutable — this list is read-only.
      </p>

      {isLoading && (
        <div className="flex min-h-[10vh] items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-pink border-t-transparent" />
        </div>
      )}

      {!isLoading && rows.length === 0 && (
        <div className="py-6 text-center text-gray-500">No resolved legs yet.</div>
      )}

      {!isLoading && rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-white/5 bg-gray-900/40">
          <table className="w-full text-sm">
            <thead className="border-b border-white/5 bg-white/5 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3">Leg #</th>
                <th className="px-4 py-3">Question</th>
                <th className="px-4 py-3 text-center">Outcome</th>
                <th className="px-4 py-3">Resolver</th>
                <th className="px-4 py-3">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={`${r.txHash}:${r.legId.toString()}`} className="align-top text-gray-300">
                  <td className="px-4 py-3 font-mono text-gray-500">#{r.legId.toString()}</td>
                  <td className="px-4 py-3 max-w-[360px]">
                    <div className="whitespace-normal">{r.question}</div>
                  </td>
                  <td className="px-4 py-3 text-center font-mono text-xs">
                    <span className={`rounded-full border px-2 py-0.5 ${outcomeBadge(r.status)}`}>
                      {outcomeLabel(r.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{shortAddr(r.resolver)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{fmtTime(r.resolvedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function outcomeLabel(status: number): string {
  if (status === 1) return "YES";
  if (status === 2) return "NO";
  if (status === 3) return "VOID";
  return "—";
}

function outcomeBadge(status: number): string {
  if (status === 1) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (status === 2) return "border-red-500/40 bg-red-500/10 text-red-300";
  if (status === 3) return "border-white/10 bg-white/5 text-gray-400";
  return "border-white/10 bg-white/5 text-gray-500";
}

function shortAddr(addr: `0x${string}`): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function ResolveButton({
  onClick,
  disabled,
  tone,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone: "yes" | "no" | "void";
  children: React.ReactNode;
}) {
  const toneClass = useMemo(() => {
    if (tone === "yes") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20";
    if (tone === "no") return "border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20";
    return "border-white/10 bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white";
  }, [tone]);

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
    >
      {children}
    </button>
  );
}

// ── Layout helper ─────────────────────────────────────────────────────────

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/5 bg-gray-900/30 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── Utilities ─────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function fmtTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function fmtPct(ppm: number | null | undefined): string {
  if (ppm == null) return "—";
  return `${(ppm / 10_000).toFixed(1)}%`;
}

function fmtStake(stake: bigint): string {
  return formatUSDC(stake, { locale: true });
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
