"use client";

import { useState, useEffect, useCallback } from "react";
import { useDeployedContract } from "../../hooks/useDeployedContract";
import { useContractClient } from "./_internal";

export interface LegInfo {
  question: string;
  sourceRef: string;
  cutoffTime: bigint;
  earliestResolve: bigint;
  oracleAdapter: `0x${string}`;
  probabilityPPM: bigint;
  active: boolean;
}

/** LegStatus enum values from the contract: 0=Unresolved, 1=Won, 2=Lost, 3=Voided */
export interface LegOracleResult {
  resolved: boolean;
  status: number; // 0=Unresolved, 1=Won, 2=Lost, 3=Voided
}

/** Fetches leg details from LegRegistry for an array of leg IDs */
export function useLegDescriptions(legIds: readonly bigint[]) {
  const publicClient = useContractClient();
  const registry = useDeployedContract("LegRegistry");
  const [legs, setLegs] = useState<Map<string, LegInfo>>(new Map());

  const legIdsKey = JSON.stringify(legIds.map(String));

  const fetchLegs = useCallback(async () => {
    if (!publicClient || !registry || legIds.length === 0) return;

    const map = new Map<string, LegInfo>();
    for (const legId of legIds) {
      const key = legId.toString();
      if (map.has(key)) continue;
      try {
        const data = await publicClient.readContract({
          address: registry.address,
          abi: registry.abi,
          functionName: "getLeg",
          args: [legId],
        });
        map.set(key, data as LegInfo);
      } catch {
        // skip
      }
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
 * Each leg stores its own `oracleAdapter` address (AdminOracleAdapter during
 * bootstrap, OptimisticOracleAdapter in production). Both implement
 * `IOracleAdapter`, so we reuse AdminOracleAdapter's ABI from
 * `deployedContracts.ts` — `getStatus`'s signature is interface-enforced.
 */
export function useLegStatuses(
  legIds: readonly bigint[],
  legMap: Map<string, LegInfo>,
  pollIntervalMs = 5000,
) {
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
