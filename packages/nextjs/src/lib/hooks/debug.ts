"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LOCAL_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "@parlayvoo/shared";
import { useDeployedContract } from "./useDeployedContract";
import { useAllTickets } from "./ticket";
import { useContractClient, usePinnedChainId } from "./_internal";
import type { LegInfo } from "./leg";

export function useIsTestnet(): boolean {
  const chainId = usePinnedChainId();
  return chainId === LOCAL_CHAIN_ID || chainId === BASE_SEPOLIA_CHAIN_ID;
}

export interface OpenLeg {
  legId: bigint;
  sourceRef: string;
  /** Richest available: DB row's txtquestion, falling back to on-chain. */
  question: string;
  cutoffTime: bigint;
  /** DB yes-side probability in PPM (matches on-chain when synced). */
  yesProbabilityPPM: number | null;
  /** DB no-side probability; null for seed legs or missing markets. */
  noProbabilityPPM: number | null;
  /** On-chain value, kept as a last-resort display fallback. */
  onChainProbabilityPPM: bigint;
  oracleAdapter: `0x${string}`;
}

interface MarketsApiResponse {
  legs: Array<{
    sourceRef: string;
    question: string;
    probabilityPPM: number;
    noProbabilityPPM?: number;
  }>;
}

async function fetchMarketMap(): Promise<Map<string, MarketsApiResponse["legs"][number]>> {
  const res = await fetch("/api/markets", { cache: "no-store" });
  if (!res.ok) return new Map();
  const markets = (await res.json()) as Array<MarketsApiResponse>;
  const map = new Map<string, MarketsApiResponse["legs"][number]>();
  for (const m of markets) {
    for (const leg of m.legs) map.set(leg.sourceRef, leg);
  }
  return map;
}

/**
 * Lists every unresolved leg referenced by any ticket in the engine. Powers
 * the F-6 debug page: iterate tickets → union of legIds → filter by
 * `canResolve`, then enrich with DB metadata (/api/markets) so the table
 * shows the real question + yes/no probabilities instead of whatever the
 * engine copied into LegRegistry at quote time.
 */
export function useOpenLegs() {
  const { tickets, isLoading: ticketsLoading, refetch: refetchTickets } = useAllTickets();
  const publicClient = useContractClient();
  const registry = useDeployedContract("LegRegistry");
  const oracle = useDeployedContract("AdminOracleAdapter");

  const [legs, setLegs] = useState<OpenLeg[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const fetchIdRef = useRef(0);

  const uniqueLegIds = useMemo(() => {
    const set = new Set<string>();
    for (const t of tickets) {
      for (const id of t.ticket.legIds) set.add(id.toString());
    }
    return Array.from(set).map((s) => BigInt(s));
  }, [tickets]);

  const legIdsKey = useMemo(() => uniqueLegIds.map((id) => id.toString()).join(","), [uniqueLegIds]);

  const fetchLegs = useCallback(async () => {
    if (!publicClient || !registry || !oracle) return;
    const localId = ++fetchIdRef.current;

    if (uniqueLegIds.length === 0) {
      setLegs([]);
      setIsLoading(false);
      return;
    }

    const [marketMap, ...legResults] = await Promise.all([
      fetchMarketMap(),
      ...uniqueLegIds.map(async (legId) => {
        try {
          const [leg, canResolve] = await Promise.all([
            publicClient.readContract({
              address: registry.address,
              abi: registry.abi,
              functionName: "getLeg",
              args: [legId],
            }) as Promise<LegInfo>,
            publicClient.readContract({
              address: oracle.address,
              abi: oracle.abi,
              functionName: "canResolve",
              args: [legId],
            }) as Promise<boolean>,
          ]);
          return { legId, leg, canResolve };
        } catch {
          return null;
        }
      }),
    ]);

    const rows: OpenLeg[] = [];
    for (const result of legResults) {
      if (!result || result.canResolve) continue;
      const { legId, leg } = result;
      const dbRow = marketMap.get(leg.sourceRef);
      rows.push({
        legId,
        sourceRef: leg.sourceRef,
        question: dbRow?.question || leg.question || "—",
        cutoffTime: leg.cutoffTime,
        yesProbabilityPPM: dbRow?.probabilityPPM ?? null,
        noProbabilityPPM: dbRow?.noProbabilityPPM ?? null,
        onChainProbabilityPPM: leg.probabilityPPM,
        oracleAdapter: leg.oracleAdapter,
      });
    }

    if (localId !== fetchIdRef.current) return;
    rows.sort((a, b) => (a.cutoffTime > b.cutoffTime ? -1 : a.cutoffTime < b.cutoffTime ? 1 : 0));
    setLegs(rows);
    setIsLoading(false);
  }, [publicClient, registry?.address, oracle?.address, legIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchLegs();
  }, [fetchLegs]);

  const refetch = useCallback(() => {
    refetchTickets();
    fetchLegs();
  }, [refetchTickets, fetchLegs]);

  return { legs, isLoading: isLoading || ticketsLoading, refetch };
}
