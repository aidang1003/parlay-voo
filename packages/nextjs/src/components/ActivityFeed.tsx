"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useEnsName } from "wagmi";
import { mainnet } from "wagmi/chains";
import { useTicketActivity, useTicket, type ActivityEvent } from "@/lib/hooks";
import { formatUSDC } from "@/lib/utils";

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

const STATUS_LABEL: Record<number, { label: string; cls: string }> = {
  1: { label: "won", cls: "text-neon-green" },
  2: { label: "lost", cls: "text-neon-red" },
  3: { label: "voided", cls: "text-gray-400" },
  4: { label: "claimed", cls: "text-neon-green" },
};

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
  const { ticket } = useTicket(event.kind === "purchased" ? undefined : event.ticketId);

  // Resolve buyer for `settled` events (event itself doesn't carry it).
  const fallbackBuyer = useMemo(() => ticket?.buyer, [ticket?.buyer]);
  const addr = event.buyer ?? fallbackBuyer;

  const ensResult = useEnsName({ address: addr, chainId: mainnet.id });
  const display = ensResult.data ?? (addr ? shortAddress(addr) : "—");

  const verbNode = renderVerb(event, ticket);

  return (
    <Link
      href={`/ticket/${event.ticketId.toString()}`}
      className="flex flex-wrap items-center gap-2 rounded-xl border border-white/5 bg-white/5 px-4 py-3 text-sm transition-colors hover:bg-white/10"
    >
      <span className="font-mono text-xs text-gray-400">{display}</span>
      {verbNode}
      <span className="ml-auto text-xs text-gray-500">{relativeTime(event.timestamp)}</span>
    </Link>
  );
}

function renderVerb(event: ActivityEvent, ticket: ReturnType<typeof useTicket>["ticket"]) {
  switch (event.kind) {
    case "purchased": {
      const stake = ticket?.stake;
      const legCount = ticket?.legIds.length;
      return (
        <>
          <span className="text-white">bought</span>
          <span className="rounded-md bg-brand-pink/10 px-2 py-0.5 text-xs font-semibold text-brand-pink">
            #{event.ticketId.toString()}
          </span>
          {legCount !== undefined && (
            <span className="text-xs text-gray-500">{legCount} leg{legCount === 1 ? "" : "s"}</span>
          )}
          {stake !== undefined && (
            <span className="text-xs font-semibold text-white">
              ${formatUSDC(stake, { locale: true })}
            </span>
          )}
        </>
      );
    }
    case "settled": {
      const meta = STATUS_LABEL[event.status ?? 0];
      return (
        <>
          <span className="text-gray-400">settled</span>
          <span className="rounded-md bg-brand-purple/10 px-2 py-0.5 text-xs font-semibold text-brand-purple-1">
            #{event.ticketId.toString()}
          </span>
          {meta && (
            <span className={`text-xs font-semibold ${meta.cls}`}>{meta.label}</span>
          )}
        </>
      );
    }
    case "cashedOut": {
      return (
        <>
          <span className="text-gray-400">cashed out</span>
          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-300">
            #{event.ticketId.toString()}
          </span>
          {event.cashoutValue !== undefined && (
            <span className="text-xs font-semibold text-amber-300">
              ${formatUSDC(event.cashoutValue, { locale: true })}
            </span>
          )}
        </>
      );
    }
  }
}
