"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAllTickets } from "@/lib/hooks";
import { mapStatus, formatUSDC } from "@/lib/utils";
import type { TicketStatus } from "@/components/TicketCard";

type TabFilter = "all" | "active" | "won" | "lost" | "voided" | "claimed";

const TABS: { key: TabFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
  { key: "voided", label: "Voided" },
  { key: "claimed", label: "Claimed" },
];

function matches(status: TicketStatus, tab: TabFilter): boolean {
  if (tab === "all") return true;
  if (tab === "active") return status === "Active";
  if (tab === "won") return status === "Won";
  if (tab === "lost") return status === "Lost";
  if (tab === "voided") return status === "Voided";
  if (tab === "claimed") return status === "Claimed";
  return true;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const fmtUsdc = (amount: bigint): string => formatUSDC(amount, { locale: true });

function fmtTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

interface TriggerResult {
  resolved: number;
  settled: number;
  skipped: number;
  errors: string[];
}

export default function AdminTicketsPage() {
  const { tickets, isLoading, error, refetch } = useAllTickets();
  const [tab, setTab] = useState<TabFilter>("all");
  const [isRunning, setIsRunning] = useState(false);
  const [runResult, setRunResult] = useState<TriggerResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  async function runSettlementNow() {
    setIsRunning(true);
    setRunResult(null);
    setRunError(null);
    try {
      const res = await fetch("/api/settlement/trigger", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setRunResult(body as TriggerResult);
      refetch();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsRunning(false);
    }
  }

  const rows = useMemo(
    () =>
      tickets.map((t) => ({
        id: t.id,
        owner: t.owner,
        stake: t.ticket.stake,
        payout: t.ticket.potentialPayout,
        status: mapStatus(t.ticket.status),
        legCount: t.ticket.legIds.length,
        createdAt: Number(t.ticket.createdAt),
      })),
    [tickets],
  );

  const tabCounts = useMemo(() => {
    const counts: Record<TabFilter, number> = {
      all: rows.length,
      active: 0,
      won: 0,
      lost: 0,
      voided: 0,
      claimed: 0,
    };
    for (const r of rows) {
      if (r.status === "Active") counts.active++;
      else if (r.status === "Won") counts.won++;
      else if (r.status === "Lost") counts.lost++;
      else if (r.status === "Voided") counts.voided++;
      else if (r.status === "Claimed") counts.claimed++;
    }
    return counts;
  }, [rows]);

  const filtered = useMemo(
    () => rows.filter((r) => matches(r.status, tab)).sort((a, b) => Number(b.id - a.id)),
    [rows, tab],
  );

  return (
    <div className="space-y-6">
      <section className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-black text-white">
            Admin · <span className="gradient-text">All Tickets</span>
          </h1>
          <p className="mt-2 text-gray-400">
            Every ticket in the engine, across all wallets. Read-only; for settlement audits.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={runSettlementNow}
            disabled={isRunning}
            className="rounded-lg border border-brand-pink/40 bg-brand-pink/10 px-4 py-2 text-sm font-semibold text-brand-pink transition-colors hover:bg-brand-pink/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunning ? "Running…" : "Run settlement now"}
          </button>
          <button
            onClick={() => refetch()}
            className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            Refresh
          </button>
        </div>
      </section>

      {runResult && (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-300">
          <span className="font-semibold">Settlement run complete.</span>{" "}
          Resolved {runResult.resolved} · Settled {runResult.settled} · Skipped {runResult.skipped}
          {runResult.errors.length > 0 && (
            <div className="mt-2 text-xs text-amber-300">
              {runResult.errors.length} error{runResult.errors.length === 1 ? "" : "s"}:{" "}
              {runResult.errors.slice(0, 3).join("; ")}
              {runResult.errors.length > 3 && " …"}
            </div>
          )}
        </div>
      )}

      {runError && (
        <div className="rounded-lg bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
          Settlement run failed: {runError.length > 200 ? runError.slice(0, 200) + "…" : runError}
        </div>
      )}

      <div className="flex flex-wrap gap-1 rounded-xl border border-white/5 bg-gray-900/50 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-2 text-sm font-semibold transition-all ${
              tab === t.key
                ? "gradient-bg text-white shadow-lg"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t.label}
            {tabCounts[t.key] > 0 && (
              <span
                className={`ml-1.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${
                  tab === t.key ? "bg-white/20 text-white" : "bg-white/5 text-gray-600"
                }`}
              >
                {tabCounts[t.key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
          Failed to load tickets: {error.length > 200 ? error.slice(0, 200) + "…" : error}
        </div>
      )}

      {isLoading && (
        <div className="flex min-h-[30vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-pink border-t-transparent" />
        </div>
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-white/5 bg-gray-900/40">
          <table className="w-full text-sm">
            <thead className="border-b border-white/5 bg-white/5 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Legs</th>
                <th className="px-4 py-3 text-right">Stake</th>
                <th className="px-4 py-3 text-right">Payout</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filtered.map((r) => (
                <tr key={r.id.toString()} className="text-gray-300 hover:bg-white/5">
                  <td className="px-4 py-3 font-mono text-gray-500">#{r.id.toString()}</td>
                  <td className="px-4 py-3 font-mono text-xs">{shortAddr(r.owner)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${statusClass(r.status)}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">{r.legCount}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtUsdc(r.stake)}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtUsdc(r.payout)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{fmtTime(r.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/ticket/${r.id.toString()}`}
                      className="text-xs text-brand-pink hover:underline"
                    >
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && rows.length === 0 && (
        <div className="py-16 text-center text-gray-500">No tickets on-chain yet.</div>
      )}

      {!isLoading && rows.length > 0 && filtered.length === 0 && (
        <div className="py-16 text-center text-gray-500">
          No tickets with status &ldquo;{tab}&rdquo;.
        </div>
      )}
    </div>
  );
}

function statusClass(status: TicketStatus): string {
  switch (status) {
    case "Active":
      return "bg-yellow-500/20 text-yellow-400";
    case "Won":
      return "bg-green-500/20 text-green-400";
    case "Lost":
      return "bg-red-500/20 text-red-400";
    case "Voided":
      return "bg-gray-500/20 text-gray-400";
    case "Claimed":
      return "bg-blue-500/20 text-blue-400";
  }
}
