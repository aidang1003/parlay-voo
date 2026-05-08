"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";

export type DeviationOutcome = "YES" | "NO" | "VOIDED";

export interface UserLegDeviation {
  sourceRef: string;
  outcome: DeviationOutcome;
}

async function fetchDeviations(wallet: string): Promise<Map<string, DeviationOutcome>> {
  const res = await fetch(`/api/legs/deviations?wallet=${wallet.toLowerCase()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`deviations fetch failed: ${res.status}`);
  const body: { deviations?: UserLegDeviation[] } = await res.json();
  const map = new Map<string, DeviationOutcome>();
  for (const d of body.deviations ?? []) map.set(d.sourceRef, d.outcome);
  return map;
}

const EMPTY_MAP: ReadonlyMap<string, DeviationOutcome> = new Map();

/** Returns the connected wallet's per-leg demo overrides, keyed by sourceRef.
 *  Empty map when no wallet is connected. The display layer prefers chain
 *  truth; this map is consulted only when a leg is still Unresolved on-chain.*/
export function useUserLegDeviations(): {
  deviations: ReadonlyMap<string, DeviationOutcome>;
  isLoading: boolean;
  refetch: () => void;
} {
  const { address } = useAccount();
  const wallet = address?.toLowerCase();
  const qc = useQueryClient();
  const queryKey = ["user-leg-deviations", wallet ?? "anon"];

  const q = useQuery({
    queryKey,
    queryFn: () => (wallet ? fetchDeviations(wallet) : Promise.resolve(new Map<string, DeviationOutcome>())),
    enabled: !!wallet,
    staleTime: 5_000,
  });

  return {
    deviations: q.data ?? EMPTY_MAP,
    isLoading: q.isLoading,
    refetch: () => qc.invalidateQueries({ queryKey }),
  };
}
