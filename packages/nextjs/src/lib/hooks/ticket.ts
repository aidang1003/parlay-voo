"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount, useReadContract } from "wagmi";
import type { Log } from "viem";
import { useDeployedContract } from "./useDeployedContract";
import { EMPTY_ABI, useContractClient, useWriteTx } from "./_internal";

export interface OnChainTicket {
  buyer: `0x${string}`;
  stake: bigint;
  legIds: readonly bigint[];
  outcomes: readonly `0x${string}`[];
  multiplierX1e6: bigint;
  potentialPayout: bigint;
  feePaid: bigint;
  /** Settlement mode: 0=FAST, 1=OPTIMISTIC (oracle dispute window) */
  mode: number;
  status: number;
  createdAt: bigint;
}

export function useTicket(ticketId: bigint | undefined) {
  const engine = useDeployedContract("ParlayEngine");

  const { data, isLoading, refetch } = useReadContract({
    address: engine?.address,
    abi: engine?.abi ?? EMPTY_ABI,
    functionName: "getTicket",
    args: ticketId !== undefined ? [ticketId] : undefined,
    query: {
      enabled: ticketId !== undefined && !!engine,
      refetchInterval: 5000,
    },
  });

  return {
    ticket: data as OnChainTicket | undefined,
    isLoading,
    refetch,
  };
}

export function useUserTickets() {
  const { address } = useAccount();
  const publicClient = useContractClient();
  const engine = useDeployedContract("ParlayEngine");
  const [tickets, setTickets] = useState<{ id: bigint; ticket: OnChainTicket }[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const hasFetchedRef = useRef(false);
  const fetchIdRef = useRef(0);
  const inFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTickets = useCallback(async () => {
    if (!address || !publicClient || !engine) {
      ++fetchIdRef.current;
      inFlightRef.current = false;
      setTickets([]);
      setTotalCount(0);
      setIsLoading(false);
      hasFetchedRef.current = false;
      return;
    }

    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const localFetchId = ++fetchIdRef.current;

    // Only show loading spinner on first fetch, not on polls
    if (!hasFetchedRef.current) setIsLoading(true);

    try {
      const count = await publicClient.readContract({
        address: engine.address,
        abi: engine.abi,
        functionName: "ticketCount",
      });

      if (localFetchId !== fetchIdRef.current) return;

      const total = Number(count as bigint);
      setTotalCount(total);
      const userTickets: { id: bigint; ticket: OnChainTicket }[] = [];

      for (let i = 0; i < total; i++) {
        if (localFetchId !== fetchIdRef.current) return;
        try {
          const owner = await publicClient.readContract({
            address: engine.address,
            abi: engine.abi,
            functionName: "ownerOf",
            args: [BigInt(i)],
          });

          if ((owner as string).toLowerCase() === address.toLowerCase()) {
            const ticket = await publicClient.readContract({
              address: engine.address,
              abi: engine.abi,
              functionName: "getTicket",
              args: [BigInt(i)],
            });
            userTickets.push({ id: BigInt(i), ticket: ticket as OnChainTicket });
          }
        } catch (innerErr) {
          console.error(`Failed to fetch ticket #${i}:`, innerErr);
        }
      }

      if (localFetchId !== fetchIdRef.current) return;
      setTickets(userTickets);
      setError(null);
    } catch (err) {
      if (localFetchId !== fetchIdRef.current) return;
      console.error("Failed to fetch tickets:", err);
      setError(String(err));
    } finally {
      if (localFetchId === fetchIdRef.current) {
        inFlightRef.current = false;
        setIsLoading(false);
        hasFetchedRef.current = true;
      }
    }
  }, [address, publicClient, engine?.address]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch on mount and poll every 5 seconds
  useEffect(() => {
    fetchTickets();
    const interval = setInterval(fetchTickets, 5000);
    return () => clearInterval(interval);
  }, [fetchTickets]);

  return { tickets, totalCount, isLoading, error, refetch: fetchTickets };
}

export interface TicketWithOwner {
  id: bigint;
  ticket: OnChainTicket;
  owner: `0x${string}`;
}

/** Fetch every ticket in the engine, regardless of caller. */
export function useAllTickets() {
  const publicClient = useContractClient();
  const engine = useDeployedContract("ParlayEngine");
  const [tickets, setTickets] = useState<TicketWithOwner[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasFetchedRef = useRef(false);
  const fetchIdRef = useRef(0);
  const inFlightRef = useRef(false);

  const fetchAll = useCallback(async () => {
    if (!publicClient || !engine) {
      setTickets([]);
      setIsLoading(false);
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const localFetchId = ++fetchIdRef.current;
    if (!hasFetchedRef.current) setIsLoading(true);

    try {
      const count = (await publicClient.readContract({
        address: engine.address,
        abi: engine.abi,
        functionName: "ticketCount",
      })) as bigint;
      if (localFetchId !== fetchIdRef.current) return;

      const total = Number(count);
      const all: TicketWithOwner[] = [];
      for (let i = 0; i < total; i++) {
        if (localFetchId !== fetchIdRef.current) return;
        try {
          const [ticket, owner] = await Promise.all([
            publicClient.readContract({
              address: engine.address,
              abi: engine.abi,
              functionName: "getTicket",
              args: [BigInt(i)],
            }),
            publicClient.readContract({
              address: engine.address,
              abi: engine.abi,
              functionName: "ownerOf",
              args: [BigInt(i)],
            }),
          ]);
          all.push({
            id: BigInt(i),
            ticket: ticket as OnChainTicket,
            owner: owner as `0x${string}`,
          });
        } catch (innerErr) {
          console.error(`Failed to fetch ticket #${i}:`, innerErr);
        }
      }
      if (localFetchId !== fetchIdRef.current) return;
      setTickets(all);
      setError(null);
    } catch (err) {
      if (localFetchId !== fetchIdRef.current) return;
      setError(String(err));
    } finally {
      if (localFetchId === fetchIdRef.current) {
        inFlightRef.current = false;
        setIsLoading(false);
        hasFetchedRef.current = true;
      }
    }
  }, [publicClient, engine?.address]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 10_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  return { tickets, isLoading, error, refetch: fetchAll };
}

export type ActivityKind = "purchased" | "settled" | "cashedOut";

export interface ActivityEvent {
  kind: ActivityKind;
  ticketId: bigint;
  buyer?: `0x${string}`;
  /** Resolved status code (TicketStatus enum) for `settled` events. */
  status?: number;
  /** Cashout payout (USDC, 6dp) for `cashedOut` events. */
  cashoutValue?: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
  /** Set after we look up the block timestamp; undefined while pending. */
  timestamp?: number;
}

/**
 * Recent ticket activity across the whole protocol, sourced from
 * `TicketPurchased` / `TicketSettled` / `EarlyCashout` events on the engine.
 * Used by the /tickets Activity tab. Polls every 30s; capped at `limit`
 * events sorted newest-first.
 */
export function useTicketActivity({ limit = 100 }: { limit?: number } = {}) {
  const publicClient = useContractClient();
  const engine = useDeployedContract("ParlayEngine");
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);
  const inFlightRef = useRef(false);

  const fetchEvents = useCallback(async () => {
    if (!publicClient || !engine) {
      setEvents([]);
      setIsLoading(false);
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const localFetchId = ++fetchIdRef.current;

    try {
      // Pull all three event types from genesis. ParlayEngine is recent enough
      // that this is cheap on Anvil/Sepolia; switch to a windowed scan if log
      // volume ever bites.
      const [purchasedLogs, settledLogs, cashoutLogs] = await Promise.all([
        publicClient.getContractEvents({
          address: engine.address,
          abi: engine.abi,
          eventName: "TicketPurchased",
          fromBlock: 0n,
          toBlock: "latest",
        }),
        publicClient.getContractEvents({
          address: engine.address,
          abi: engine.abi,
          eventName: "TicketSettled",
          fromBlock: 0n,
          toBlock: "latest",
        }),
        publicClient.getContractEvents({
          address: engine.address,
          abi: engine.abi,
          eventName: "EarlyCashout",
          fromBlock: 0n,
          toBlock: "latest",
        }),
      ]);

      if (localFetchId !== fetchIdRef.current) return;

      type DecodedLog = Log<bigint, number, false> & { args: Record<string, unknown> };
      const all: ActivityEvent[] = [];
      for (const log of purchasedLogs as unknown as DecodedLog[]) {
        const args = log.args;
        all.push({
          kind: "purchased",
          ticketId: args.ticketId as bigint,
          buyer: args.buyer as `0x${string}`,
          blockNumber: log.blockNumber!,
          txHash: log.transactionHash!,
        });
      }
      for (const log of settledLogs as unknown as DecodedLog[]) {
        const args = log.args;
        all.push({
          kind: "settled",
          ticketId: args.ticketId as bigint,
          status: Number(args.status as number | bigint),
          blockNumber: log.blockNumber!,
          txHash: log.transactionHash!,
        });
      }
      for (const log of cashoutLogs as unknown as DecodedLog[]) {
        const args = log.args;
        all.push({
          kind: "cashedOut",
          ticketId: args.ticketId as bigint,
          buyer: args.owner as `0x${string}`,
          cashoutValue: args.cashoutValue as bigint,
          blockNumber: log.blockNumber!,
          txHash: log.transactionHash!,
        });
      }

      // Newest first; clip to limit before resolving timestamps so we don't pay
      // the block-read cost on events the UI will throw away.
      all.sort((a, b) =>
        a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1,
      );
      const clipped = all.slice(0, limit);

      // Batch-resolve timestamps for distinct blocks only.
      const distinctBlocks = Array.from(new Set(clipped.map((e) => e.blockNumber)));
      const blockTimestamps = new Map<bigint, number>();
      await Promise.all(
        distinctBlocks.map(async (blockNumber) => {
          try {
            const block = await publicClient.getBlock({ blockNumber });
            blockTimestamps.set(blockNumber, Number(block.timestamp));
          } catch {
            // best-effort — leave timestamp undefined and the UI will fall back
          }
        }),
      );

      if (localFetchId !== fetchIdRef.current) return;

      const enriched = clipped.map((e) => ({
        ...e,
        timestamp: blockTimestamps.get(e.blockNumber),
      }));

      setEvents(enriched);
      setError(null);
    } catch (err) {
      if (localFetchId !== fetchIdRef.current) return;
      console.error("Failed to fetch ticket activity:", err);
      setError(String(err));
    } finally {
      if (localFetchId === fetchIdRef.current) {
        inFlightRef.current = false;
        setIsLoading(false);
      }
    }
  }, [publicClient, engine?.address, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchEvents();
    const interval = setInterval(fetchEvents, 30_000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  return { events, isLoading, error, refetch: fetchEvents };
}

export function useSettleTicket() {
  const engine = useDeployedContract("ParlayEngine");
  const tx = useWriteTx();
  const settle = (ticketId: bigint): Promise<boolean> => {
    if (!engine) return Promise.resolve(false);
    return tx.run({
      address: engine.address,
      abi: engine.abi,
      functionName: "settleTicket",
      args: [ticketId],
      label: "Settle ticket",
    });
  };
  return { settle, hash: tx.hash, isPending: tx.isPending, isConfirming: tx.isConfirming, isSuccess: tx.isSuccess, error: tx.error };
}

export function useClaimPayout() {
  const engine = useDeployedContract("ParlayEngine");
  const tx = useWriteTx();
  const claim = (ticketId: bigint): Promise<boolean> => {
    if (!engine) return Promise.resolve(false);
    return tx.run({
      address: engine.address,
      abi: engine.abi,
      functionName: "claimPayout",
      args: [ticketId],
      label: "Claim payout",
    });
  };
  return { claim, hash: tx.hash, isPending: tx.isPending, isConfirming: tx.isConfirming, isSuccess: tx.isSuccess, error: tx.error };
}

export function useCashoutEarly() {
  const engine = useDeployedContract("ParlayEngine");
  const tx = useWriteTx();
  const cashoutEarly = (ticketId: bigint, minOut: bigint = 0n): Promise<boolean> => {
    if (!engine) return Promise.resolve(false);
    return tx.run({
      address: engine.address,
      abi: engine.abi,
      functionName: "cashoutEarly",
      args: [ticketId, minOut],
      label: "Early cashout",
    });
  };
  return { cashoutEarly, hash: tx.hash, isPending: tx.isPending, isConfirming: tx.isConfirming, isSuccess: tx.isSuccess, error: tx.error };
}
