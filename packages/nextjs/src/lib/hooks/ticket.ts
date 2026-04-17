"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount, useReadContract } from "wagmi";
import { BUILDER_SUFFIX } from "../builder-code";
import { useDeployedContract } from "../../hooks/useDeployedContract";
import { EMPTY_ABI, useContractClient, usePinnedWriteContract } from "./_internal";

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

export function useSettleTicket() {
  const publicClient = useContractClient();
  const engine = useDeployedContract("ParlayEngine");
  const { writeContractAsync } = usePinnedWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>(undefined);
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const settle = async (ticketId: bigint): Promise<boolean> => {
    if (!publicClient || !engine) return false;

    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);
    setHash(undefined);

    try {
      const txHash = await writeContractAsync({
        address: engine.address,
        abi: engine.abi,
        functionName: "settleTicket",
        args: [ticketId],
        dataSuffix: BUILDER_SUFFIX,
      });
      setHash(txHash);

      setIsPending(false);
      setIsConfirming(true);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "reverted") {
        throw new Error("Settle transaction reverted on-chain");
      }

      setIsConfirming(false);
      setIsSuccess(true);
      return true;
    } catch (err) {
      console.error("Settle ticket failed:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      setIsPending(false);
      setIsConfirming(false);
    }
  };

  return { settle, hash, isPending, isConfirming, isSuccess, error };
}

export function useClaimPayout() {
  const publicClient = useContractClient();
  const engine = useDeployedContract("ParlayEngine");
  const { writeContractAsync } = usePinnedWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>(undefined);
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const claim = async (ticketId: bigint): Promise<boolean> => {
    if (!publicClient || !engine) return false;

    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);
    setHash(undefined);

    try {
      const txHash = await writeContractAsync({
        address: engine.address,
        abi: engine.abi,
        functionName: "claimPayout",
        args: [ticketId],
        dataSuffix: BUILDER_SUFFIX,
      });
      setHash(txHash);

      setIsPending(false);
      setIsConfirming(true);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "reverted") {
        throw new Error("Claim payout transaction reverted on-chain");
      }

      setIsConfirming(false);
      setIsSuccess(true);
      return true;
    } catch (err) {
      console.error("Claim payout failed:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      setIsPending(false);
      setIsConfirming(false);
    }
  };

  return { claim, hash, isPending, isConfirming, isSuccess, error };
}

export function useCashoutEarly() {
  const publicClient = useContractClient();
  const engine = useDeployedContract("ParlayEngine");
  const { writeContractAsync } = usePinnedWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>(undefined);
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const cashoutEarly = async (ticketId: bigint, minOut: bigint = 0n): Promise<boolean> => {
    if (!publicClient || !engine) return false;

    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);
    setHash(undefined);

    try {
      const txHash = await writeContractAsync({
        address: engine.address,
        abi: engine.abi,
        functionName: "cashoutEarly",
        args: [ticketId, minOut],
        dataSuffix: BUILDER_SUFFIX,
      });
      setHash(txHash);

      setIsPending(false);
      setIsConfirming(true);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "reverted") {
        throw new Error("Early cashout reverted on-chain");
      }

      setIsConfirming(false);
      setIsSuccess(true);
      return true;
    } catch (err) {
      console.error("Early cashout failed:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      setIsPending(false);
      setIsConfirming(false);
    }
  };

  return { cashoutEarly, hash, isPending, isConfirming, isSuccess, error };
}
