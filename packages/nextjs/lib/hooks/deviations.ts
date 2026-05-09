"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";

export type DeviationOutcome = "YES" | "NO" | "VOIDED";
export type TicketDeviationStatus = "Won" | "Lost" | "Voided" | "Claimed";

export interface UserLegDeviation {
  sourceRef: string;
  outcome: DeviationOutcome;
}

export interface TicketDeviation {
  ticketId: bigint;
  status: TicketDeviationStatus;
  payout: bigint;
  multiplierX1e6: bigint;
  claimTxHash: string | null;
}

interface RawTicketDeviation {
  ticketId: string;
  status: TicketDeviationStatus;
  payout: string;
  multiplierX1e6: string;
  claimTxHash: string | null;
}

interface FetchResult {
  legs: Map<string, DeviationOutcome>;
  tickets: Map<string, TicketDeviation>; // keyed by ticketId.toString()
}

const EMPTY_RESULT: FetchResult = { legs: new Map(), tickets: new Map() };

async function fetchDeviations(wallet: string): Promise<FetchResult> {
  const res = await fetch(`/api/legs/deviations?wallet=${wallet.toLowerCase()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`deviations fetch failed: ${res.status}`);
  const body: { deviations?: UserLegDeviation[]; tickets?: RawTicketDeviation[] } = await res.json();
  const legs = new Map<string, DeviationOutcome>();
  for (const d of body.deviations ?? []) legs.set(d.sourceRef, d.outcome);
  const tickets = new Map<string, TicketDeviation>();
  for (const t of body.tickets ?? []) {
    tickets.set(t.ticketId, {
      ticketId: BigInt(t.ticketId),
      status: t.status,
      payout: BigInt(t.payout),
      multiplierX1e6: BigInt(t.multiplierX1e6),
      claimTxHash: t.claimTxHash,
    });
  }
  return { legs, tickets };
}

/** Connected wallet's per-leg + per-ticket demo overrides. The display layer
 *  prefers chain truth; these maps are consulted only when chain state is
 *  still pre-resolution. Empty maps when no wallet is connected. */
export function useUserLegDeviations(): {
  deviations: ReadonlyMap<string, DeviationOutcome>;
  ticketDeviations: ReadonlyMap<string, TicketDeviation>;
  isLoading: boolean;
  refetch: () => void;
} {
  const { address } = useAccount();
  const wallet = address?.toLowerCase();
  const qc = useQueryClient();
  const queryKey = ["user-leg-deviations", wallet ?? "anon"];

  const q = useQuery({
    queryKey,
    queryFn: () => (wallet ? fetchDeviations(wallet) : Promise.resolve(EMPTY_RESULT)),
    enabled: !!wallet,
    staleTime: 5_000,
  });

  return {
    deviations: q.data?.legs ?? EMPTY_RESULT.legs,
    ticketDeviations: q.data?.tickets ?? EMPTY_RESULT.tickets,
    isLoading: q.isLoading,
    refetch: () => qc.invalidateQueries({ queryKey }),
  };
}
