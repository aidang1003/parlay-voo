"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchQuestionMapCached } from "../markets-cache";
import { useContractClient } from "./_internal";
import { useDeployedContract } from "./useDeployedContract";

export interface LegInfo {
  question: string;
  sourceRef: string;
  cutoffTime: bigint;
  earliestResolve: bigint;
  oracleAdapter: `0x${string}`;
  probabilityPPM: bigint;
  active: boolean;
}

export interface LegOracleResult {
  resolved: boolean;
  status: number; // 0=Unresolved, 1=Won, 2=Lost, 3=Voided
}

export function useLegDescriptions(legIds: readonly bigint[]) {
  const publicClient = useContractClient();
  const registry = useDeployedContract("LegRegistry");
  const [legs, setLegs] = useState<Map<string, LegInfo>>(new Map());

  const legIdsKey = JSON.stringify(legIds.map(String));

  const fetchLegs = useCallback(async () => {
    if (!publicClient || !registry || legIds.length === 0) return;

    const uniqueIds = Array.from(new Set(legIds.map(id => id.toString())));
    const [questionMap, ...results] = await Promise.all([
      fetchQuestionMapCached(),
      ...uniqueIds.map(async key => {
        try {
          const data = await publicClient.readContract({
            address: registry.address,
            abi: registry.abi,
            functionName: "getLeg",
            args: [BigInt(key)],
          });
          return { key, leg: data as LegInfo };
        } catch {
          return null;
        }
      }),
    ]);

    const map = new Map<string, LegInfo>();
    for (const r of results) {
      if (!r) continue;
      const dbQuestion = questionMap.get(r.leg.sourceRef);
      map.set(r.key, dbQuestion ? { ...r.leg, question: dbQuestion } : r.leg);
    }
    setLegs(map);
  }, [publicClient, registry?.address, legIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchLegs();
  }, [fetchLegs]);

  return legs;
}

/**
 * Queries each leg's oracle adapter for individual resolution status.
 *
 * Each leg stores its own `oracleAdapter` address (AdminOracleAdapter on
 * testnet, UmaOracleAdapter on Base mainnet). Both implement
 * `IOracleAdapter`, so we reuse AdminOracleAdapter's ABI from
 * `deployedContracts.ts` — `getStatus`'s signature is interface-enforced.
 */
export function useLegStatuses(legIds: readonly bigint[], legMap: Map<string, LegInfo>, pollIntervalMs = 5000) {
  const publicClient = useContractClient();
  const oracle = useDeployedContract("AdminOracleAdapter");
  const [statuses, setStatuses] = useState<Map<string, LegOracleResult>>(new Map());

  const legIdsKey = JSON.stringify(legIds.map(String));

  const fetchStatuses = useCallback(async () => {
    if (!publicClient || !oracle || legIds.length === 0 || legMap.size === 0) return;

    const map = new Map<string, LegOracleResult>();
    for (const legId of legIds) {
      const key = legId.toString();
      const leg = legMap.get(key);
      if (!leg || !leg.oracleAdapter) {
        map.set(key, { resolved: false, status: 0 });
        continue;
      }
      try {
        const data = await publicClient.readContract({
          address: leg.oracleAdapter,
          abi: oracle.abi,
          functionName: "getStatus",
          args: [legId],
        });
        const [status] = data as [number, `0x${string}`];
        map.set(key, { resolved: status !== 0, status });
      } catch {
        map.set(key, { resolved: false, status: 0 });
      }
    }
    setStatuses(map);
  }, [publicClient, oracle?.abi, legIdsKey, legMap.size]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchStatuses();
    const interval = setInterval(fetchStatuses, pollIntervalMs);
    return () => clearInterval(interval);
  }, [fetchStatuses, pollIntervalMs]);

  return statuses;
}
