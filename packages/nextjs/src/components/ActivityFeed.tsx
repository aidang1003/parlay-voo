"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useEnsName } from "wagmi";
import { mainnet } from "wagmi/chains";
import { useTicketActivity, useTicket, type ActivityEvent } from "@/lib/hooks";
import { useLegDescriptions } from "@/lib/hooks/leg";
import { formatUSDC, parseOutcomeChoice } from "@/lib/utils";

function shortAddress(addr: `0x${string}`) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function relativeTime(ts: number | undefined): string {
  if (!ts) return "just now";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function ActivityFeed() {
  const { events, isLoading, error } = useTicketActivity({ limit: 100 });

  if (isLoading && events.length === 0) {
    return (
      <div className="flex min-h-[30vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-pink border-t-transparent" />
      </div>
    );
  }

  if (error && events.length === 0) {
    return (
      <div className="rounded-lg bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
        Failed to load activity: {error.length > 200 ? error.slice(0, 200) + "..." : error}
      </div>
    );
  }

  if (!isLoading && events.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-gray-500">No activity yet on this network.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {events.map((e) => (
        <ActivityRow key={`${e.txHash}-${e.kind}-${e.ticketId.toString()}`} event={e} />
      ))}
    </div>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const { ticket } = useTicket(event.ticketId);

  const legIds = useMemo(() => (ticket?.legIds ? Array.from(ticket.legIds) : []), [ticket?.legIds]);
  const legMap = useLegDescriptions(legIds);
  const firstLegQuestion = legIds.length > 0 ? legMap.get(legIds[0].toString())?.question : undefined;
  const moreCount = Math.max(0, legIds.length - 1);

  const stake = ticket?.stake;
  const fallbackBuyer = useMemo(() => ticket?.buyer, [ticket?.buyer]);
  const addr = event.buyer ?? fallbackBuyer;
  const ensResult = useEnsName({ address: addr, chainId: mainnet.id });
  const display = ensResult.data ?? (addr ? shortAddress(addr) : "—");

  const summary = firstLegQuestion ?? `Ticket #${event.ticketId.toString()}`;

  return (
    <Link
      href={`/ticket/${event.ticketId.toString()}`}
      className="flex flex-wrap items-center gap-3 rounded-xl border border-white/5 bg-white/5 px-4 py-3 text-sm transition-colors hover:bg-white/10"
    >
      <span className="font-mono text-xs text-gray-400 sm:w-32 sm:flex-shrink-0">{display}</span>
      <span className="min-w-0 flex-1 truncate text-gray-200" title={summary}>
        {summary}
        {moreCount > 0 && <span className="text-gray-500"> +{moreCount} more</span>}
      </span>
      {stake !== undefined && (
        <span className="flex-shrink-0 font-mono text-xs font-semibold text-white">
          ${formatUSDC(stake, { locale: true })}
        </span>
      )}
      <StatusPill event={event} ticket={ticket} legIds={legIds} />
      <span className="flex-shrink-0 text-xs text-gray-500">{relativeTime(event.timestamp)}</span>
    </Link>
  );
}

function StatusPill({
  event,
  ticket,
  legIds,
}: {
  event: ActivityEvent;
  ticket: ReturnType<typeof useTicket>["ticket"];
  legIds: bigint[];
}) {
  // Cashout always wins regardless of current ticket status, since the row's
  // event itself records the cashout action.
  if (event.kind === "cashedOut") return <Pill tone="amber" label="Cashed out" />;

  const status = ticket?.status;

  // Active / unknown → show the side they bought on the first leg.
  if (status === undefined || status === 0) {
    const first = ticket?.outcomes?.[0];
    const choice = first ? parseOutcomeChoice(first) : 0;
    if (choice === 1) return <Pill tone="green" label={legIds.length > 1 ? "YES (leg 1)" : "YES"} />;
    if (choice === 2) return <Pill tone="red" label={legIds.length > 1 ? "NO (leg 1)" : "NO"} />;
    return <Pill tone="gray" label="Pending" />;
  }
  if (status === 1) return <Pill tone="green" label="Won" />;
  if (status === 2) return <Pill tone="red" label="Lost" />;
  if (status === 3) return <Pill tone="gray" label="Voided" />;
  if (status === 4) return <Pill tone="green" label="Claimed" />;
  return null;
}

function Pill({ tone, label }: { tone: "green" | "red" | "amber" | "gray"; label: string }) {
  const cls = {
    green: "bg-neon-green/15 text-neon-green border-neon-green/30",
    red: "bg-neon-red/15 text-neon-red border-neon-red/30",
    amber: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    gray: "bg-white/5 text-gray-400 border-white/10",
  }[tone];
  return (
    <span
      className={`flex-shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {label}
    </span>
  );
}
