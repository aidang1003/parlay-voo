"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LOCAL_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "@parlaycity/shared";
import { useDeployedContract } from "../../hooks/useDeployedContract";
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
  question: string;
  cutoffTime: bigint;
  probabilityPPM: bigint;
  oracleAdapter: `0x${string}`;
}

/**
 * Lists every unresolved leg referenced by any ticket in the engine. Powers
 * the F-6 debug page: iterate tickets → union of legIds → filter by
 * `canResolve`. Polls via `useAllTickets` (10s) and refetches leg + oracle
 * state whenever the ticket set changes.
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

    const rows: OpenLeg[] = [];
    for (const legId of uniqueLegIds) {
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
        if (canResolve) continue;
        rows.push({
          legId,
          sourceRef: leg.sourceRef,
          question: leg.question,
          cutoffTime: leg.cutoffTime,
          probabilityPPM: leg.probabilityPPM,
          oracleAdapter: leg.oracleAdapter,
        });
      } catch {
        // skip unreadable legs
      }
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
