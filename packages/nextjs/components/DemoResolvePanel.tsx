"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useUserLegDeviations } from "~~/lib/hooks";
import { notification } from "~~/utils/scaffold-eth";

interface Props {
  ticketId: bigint;
  /** True when at least one of this ticket's legs already shows a demo
   *  deviation — controls the visibility of the Reset button. */
  hasActiveDeviations: boolean;
}

/**
 * Ticket-native demo resolver (item #3). Two buttons mark the whole ticket as
 * a simulated WIN or LOSS; the server expands that intent into per-leg
 * deviations under the hood (item #4). A third button clears any active
 * deviation. None of this touches the chain.
 */
export function DemoResolvePanel({ ticketId, hasActiveDeviations }: Props) {
  const { address } = useAccount();
  const { refetch } = useUserLegDeviations();
  const [pending, setPending] = useState<"WIN" | "LOSS" | "RESET" | null>(null);

  if (!address) return null;

  async function call(action: "WIN" | "LOSS" | "RESET") {
    if (!address) return;
    setPending(action);
    const url = `/api/tickets/${ticketId.toString()}/demo-resolve${action === "RESET" ? `?wallet=${address.toLowerCase()}` : ""}`;
    try {
      const res = await fetch(url, {
        method: action === "RESET" ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: action === "RESET" ? undefined : JSON.stringify({ wallet: address.toLowerCase(), outcome: action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        notification.error(`Demo resolver failed: ${body.error ?? res.statusText}`);
        return;
      }
      notification.success(action === "RESET" ? "Cleared demo outcome" : `Simulated ${action.toLowerCase()}`);
      refetch();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="glass-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Simulate outcome</h3>
        <span className="text-[10px] uppercase tracking-wider text-gray-500">demo only</span>
      </div>
      <p className="mb-4 text-xs text-gray-400">
        Preview what winning or losing this ticket feels like in the UI. No chain transaction, no payout — settlement
        still runs against the real oracle. Deviations disappear once the chain resolves the leg.
      </p>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => call("WIN")} disabled={pending !== null} className="btn btn-sm btn-success grow">
          {pending === "WIN" ? "Marking…" : "Mark as WIN"}
        </button>
        <button onClick={() => call("LOSS")} disabled={pending !== null} className="btn btn-sm btn-error grow">
          {pending === "LOSS" ? "Marking…" : "Mark as LOSS"}
        </button>
        {hasActiveDeviations && (
          <button onClick={() => call("RESET")} disabled={pending !== null} className="btn btn-sm btn-ghost">
            {pending === "RESET" ? "Clearing…" : "Reset demo"}
          </button>
        )}
      </div>
    </div>
  );
}
