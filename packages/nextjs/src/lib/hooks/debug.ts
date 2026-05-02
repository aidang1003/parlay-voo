"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LOCAL_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "@parlayvoo/shared";
import { useDeployedContract } from "./useDeployedContract";
import { useAllTickets } from "./ticket";
import { useContractClient, usePinnedChainId } from "./_internal";
import type { LegInfo } from "./leg";
import { parseOutcomeChoice } from "../utils";

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
  /** Active tickets that bet YES on this leg. */
  yesCount: number;
  /** Active tickets that bet NO on this leg. */
  noCount: number;
  /** Summed stake (USDC, 6dp) of YES bets on this leg. */
  yesStake: bigint;
  /** Summed stake (USDC, 6dp) of NO bets on this leg. */
  noStake: bigint;
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

  // Aggregate YES/NO counts and summed stake per leg across active tickets.
  // Only active tickets count: settled / cashed-out tickets no longer drive
  // outcomes that could change with this resolver click.
  const positionsByLeg = useMemo(() => {
    const map = new Map<string, { yesCount: number; noCount: number; yesStake: bigint; noStake: bigint }>();
    for (const t of tickets) {
      if (t.ticket.status !== 0) continue;
      t.ticket.legIds.forEach((legId, i) => {
        const key = legId.toString();
        const choice = parseOutcomeChoice(t.ticket.outcomes[i]);
        let entry = map.get(key);
        if (!entry) {
          entry = { yesCount: 0, noCount: 0, yesStake: 0n, noStake: 0n };
          map.set(key, entry);
        }
        if (choice === 1) {
          entry.yesCount++;
          entry.yesStake += t.ticket.stake;
        } else if (choice === 2) {
          entry.noCount++;
          entry.noStake += t.ticket.stake;
        }
      });
    }
    return map;
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
        // Aggregates filled in below from positionsByLeg
        yesCount: 0,
        noCount: 0,
        yesStake: 0n,
        noStake: 0n,
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

  // Decorate legs with the latest YES/NO position aggregates. Done as a
  // derived view (not inside fetchLegs) so live ticket polling updates the
  // counts without re-running the on-chain leg + canResolve reads.
  const legsWithPositions = useMemo(() => {
    return legs.map((row) => {
      const positions = positionsByLeg.get(row.legId.toString());
      if (!positions) return row;
      return {
        ...row,
        yesCount: positions.yesCount,
        noCount: positions.noCount,
        yesStake: positions.yesStake,
        noStake: positions.noStake,
      };
    });
  }, [legs, positionsByLeg]);

  return { legs: legsWithPositions, isLoading: isLoading || ticketsLoading, refetch };
}

export interface ResolvedLegRow {
  legId: bigint;
  question: string;
  status: number; // 1 = Won, 2 = Lost, 3 = Voided
  resolvedAt: number; // unix seconds
  txHash: `0x${string}`;
  resolver: `0x${string}`;
}

/**
 * Recently resolved legs from the AdminOracleAdapter, newest-first, capped at
 * `limit`. Joins each `LegResolved` event with the LegRegistry record so the
 * resolver can audit which question they marked Won/Lost/Voided. Polls every
 * 30s; the testnet backfill from block 0 is cheap enough.
 */
export function useRecentResolutions({ limit = 20 }: { limit?: number } = {}) {
  const publicClient = useContractClient();
  const oracle = useDeployedContract("AdminOracleAdapter");
  const registry = useDeployedContract("LegRegistry");
  const [rows, setRows] = useState<ResolvedLegRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const fetchIdRef = useRef(0);

  const fetchResolved = useCallback(async () => {
    if (!publicClient || !oracle || !registry) {
      setRows([]);
      setIsLoading(false);
      return;
    }
    const localId = ++fetchIdRef.current;

    try {
      const logs = await publicClient.getContractEvents({
        address: oracle.address,
        abi: oracle.abi,
        eventName: "LegResolved",
        fromBlock: 0n,
        toBlock: "latest",
      });

      // Newest-first by block, then clip; resolves block timestamps + leg
      // questions in parallel only for the rows we'll actually render.
      const sorted = [...logs].sort((a, b) =>
        a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1,
      );
      const clipped = sorted.slice(0, limit);

      const enriched = await Promise.all(
        clipped.map(async (log) => {
          const args = (log as unknown as { args: Record<string, unknown> }).args;
          const legId = args.legId as bigint;
          const status = Number(args.status as number | bigint);
          const [block, leg, tx] = await Promise.all([
            publicClient.getBlock({ blockNumber: log.blockNumber! }).catch(() => null),
            publicClient.readContract({
              address: registry.address,
              abi: registry.abi,
              functionName: "getLeg",
              args: [legId],
            }).catch(() => null),
            publicClient.getTransaction({ hash: log.transactionHash! }).catch(() => null),
          ]);
          return {
            legId,
            question: ((leg as LegInfo | null)?.question) || "—",
            status,
            resolvedAt: block ? Number(block.timestamp) : 0,
            txHash: log.transactionHash!,
            resolver: (tx?.from ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
          } as ResolvedLegRow;
        }),
      );

      if (localId !== fetchIdRef.current) return;
      setRows(enriched);
    } catch (err) {
      if (localId !== fetchIdRef.current) return;
      console.error("Failed to load resolved legs:", err);
    } finally {
      if (localId === fetchIdRef.current) setIsLoading(false);
    }
  }, [publicClient, oracle?.address, registry?.address, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchResolved();
    const interval = setInterval(fetchResolved, 30_000);
    return () => clearInterval(interval);
  }, [fetchResolved]);

  return { rows, isLoading, refetch: fetchResolved };
}
