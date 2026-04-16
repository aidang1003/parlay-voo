"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount, useReadContract, useReadContracts, useWriteContract, usePublicClient, useChainId } from "wagmi";
import { parseUnits, parseEventLogs, type Abi } from "viem";
import { BUILDER_SUFFIX } from "./builder-code";
import { ORACLE_ADAPTER_ABI } from "./contracts";
import { useDeployedContract } from "../hooks/useDeployedContract";
import type { SupportedDeployedChainId } from "../contracts/deployedContracts";

/**
 * Resolves the chain this app reads from: `NEXT_PUBLIC_CHAIN_ID` if set
 * (production/local pin), else the wallet's active chain. Pinning prevents
 * "returned no data" errors when the wallet is on a chain the app is not
 * configured for.
 */
function usePinnedChainId(): SupportedDeployedChainId {
  const wallet = useChainId();
  const env = Number(process.env.NEXT_PUBLIC_CHAIN_ID);
  return (env || wallet) as SupportedDeployedChainId;
}

function useContractClient() {
  const chainId = usePinnedChainId();
  return usePublicClient({ chainId });
}

const EMPTY_ABI: Abi = [];

// ---- Read hooks ----

export interface LegInfo {
  question: string;
  sourceRef: string;
  cutoffTime: bigint;
  earliestResolve: bigint;
  oracleAdapter: `0x${string}`;
  probabilityPPM: bigint;
  active: boolean;
}

/** Fetches leg details from LegRegistry for an array of leg IDs */
export function useLegDescriptions(legIds: readonly bigint[]) {
  const publicClient = useContractClient();
  const chainId = usePinnedChainId();
  const registry = useDeployedContract("LegRegistry", { chainId });
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

/** LegStatus enum values from the contract: 0=Unresolved, 1=Won, 2=Lost, 3=Voided */
export interface LegOracleResult {
  resolved: boolean;
  status: number; // 0=Unresolved, 1=Won, 2=Lost, 3=Voided
}

/** Queries each leg's oracle adapter for individual resolution status */
export function useLegStatuses(
  legIds: readonly bigint[],
  legMap: Map<string, LegInfo>,
  pollIntervalMs = 5000,
) {
  const publicClient = useContractClient();
  const [statuses, setStatuses] = useState<Map<string, LegOracleResult>>(new Map());

  const legIdsKey = JSON.stringify(legIds.map(String));

  const fetchStatuses = useCallback(async () => {
    if (!publicClient || legIds.length === 0 || legMap.size === 0) return;

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
          abi: ORACLE_ADAPTER_ABI,
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
  }, [publicClient, legIdsKey, legMap.size]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchStatuses();
    const interval = setInterval(fetchStatuses, pollIntervalMs);
    return () => clearInterval(interval);
  }, [fetchStatuses, pollIntervalMs]);

  return statuses;
}

export function useUSDCBalance() {
  const { address } = useAccount();
  const chainId = usePinnedChainId();
  const usdc = useDeployedContract("MockUSDC", { chainId });

  const { data, isLoading, refetch } = useReadContract({
    address: usdc?.address,
    abi: usdc?.abi ?? EMPTY_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: {
      enabled: !!address && !!usdc,
      refetchInterval: 5000,
    },
  });

  return {
    balance: data as bigint | undefined,
    isLoading,
    refetch,
  };
}

export function useVaultStats() {
  const chainId = usePinnedChainId();
  const vault = useDeployedContract("HouseVault", { chainId });
  const baseContract = { address: vault?.address, abi: vault?.abi ?? EMPTY_ABI } as const;

  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      { ...baseContract, functionName: "totalAssets" },
      { ...baseContract, functionName: "totalReserved" },
      { ...baseContract, functionName: "maxUtilizationBps" },
      { ...baseContract, functionName: "freeLiquidity" },
      { ...baseContract, functionName: "maxPayout" },
    ],
    query: { enabled: !!vault, refetchInterval: 10000 },
  });

  const pick = (i: number) =>
    data?.[i]?.status === "success" ? (data[i].result as bigint) : undefined;

  const totalAssets = pick(0);
  const totalReserved = pick(1);
  const maxUtilBps = pick(2);
  const freeLiquidity = pick(3);
  const maxPayout = pick(4);

  const utilization =
    totalAssets && totalAssets > 0n && totalReserved !== undefined
      ? Number((totalReserved * 10000n) / totalAssets) / 100
      : 0;

  return {
    totalAssets,
    totalReserved,
    freeLiquidity,
    maxUtilBps,
    maxPayout,
    utilization,
    isLoading,
    refetch,
  };
}

export function useParlayConfig() {
  const chainId = usePinnedChainId();
  const engine = useDeployedContract("ParlayEngine", { chainId });
  const baseContract = { address: engine?.address, abi: engine?.abi ?? EMPTY_ABI } as const;

  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      { ...baseContract, functionName: "baseFee" },
      { ...baseContract, functionName: "perLegFee" },
      { ...baseContract, functionName: "minStake" },
      { ...baseContract, functionName: "maxLegs" },
    ],
    query: { enabled: !!engine, refetchInterval: 10000 },
  });

  const pick = (i: number) =>
    data?.[i]?.status === "success" ? (data[i].result as bigint) : undefined;

  const baseFee = pick(0);
  const perLegFee = pick(1);
  const minStake = pick(2);
  const maxLegs = pick(3);

  return {
    baseFeeBps: baseFee !== undefined ? Number(baseFee) : undefined,
    perLegFeeBps: perLegFee !== undefined ? Number(perLegFee) : undefined,
    maxLegs: maxLegs !== undefined ? Number(maxLegs) : undefined,
    minStakeUSDC: minStake !== undefined ? Number(minStake) / 1e6 : undefined,
    isLoading,
    refetch,
  };
}

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
  const chainId = usePinnedChainId();
  const engine = useDeployedContract("ParlayEngine", { chainId });

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
  const chainId = usePinnedChainId();
  const engine = useDeployedContract("ParlayEngine", { chainId });
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

// ---- Write hooks ----

/** Mint MockUSDC to the connected wallet (testnet only, 10k max per call). */
export function useMintTestUSDC() {
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const chainId = usePinnedChainId();
  const usdc = useDeployedContract("MockUSDC", { chainId });
  const { writeContractAsync } = useWriteContract();
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const canMint = !!usdc;

  const mint = async (amount: bigint = parseUnits("1000", 6)) => {
    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);
    try {
      if (!address || !publicClient || !usdc) {
        throw new Error(
          !address ? "Wallet not connected" : !publicClient ? "Client not ready" : "Minting not available on this network",
        );
      }
      const hash = await writeContractAsync({
        address: usdc.address,
        abi: usdc.abi,
        functionName: "mint",
        args: [address, amount],
        dataSuffix: BUILDER_SUFFIX,
      });
      setIsPending(false);
      setIsConfirming(true);
      await publicClient.waitForTransactionReceipt({ hash });
      setIsConfirming(false);
      setIsSuccess(true);
      clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setIsSuccess(false), 3000);
    } catch (err) {
      setIsPending(false);
      setIsConfirming(false);
      setError(err instanceof Error ? err.message : "Mint failed -- token may not be mintable");
    }
  };

  // Cleanup timeout on unmount
  useEffect(() => () => clearTimeout(successTimerRef.current), []);

  return { mint, canMint, isPending, isConfirming, isSuccess, error };
}

export function useBuyTicket() {
  const publicClient = useContractClient();
  const { address } = useAccount();
  const chainId = usePinnedChainId();
  const usdc = useDeployedContract("MockUSDC", { chainId });
  const engine = useDeployedContract("ParlayEngine", { chainId });
  const { writeContractAsync } = useWriteContract();
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastTicketId, setLastTicketId] = useState<bigint | null>(null);

  const resetSuccess = () => {
    setIsSuccess(false);
    setError(null);
    setLastTicketId(null);
  };

  const buyTicket = async (
    legs: Array<{ sourceRef: string; side: "yes" | "no" }>,
    stakeUsdc: number
  ): Promise<boolean> => {
    if (!address || !publicClient || !usdc || !engine) return false;

    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);

    try {
      const stakeAmount = parseUnits(stakeUsdc.toString(), 6);

      // Fetch a fresh EIP-712 signed Quote from our backend. Short TTL (60s)
      // bounds price staleness; the engine verifies sig+nonce+deadline+buyer.
      const quoteRes = await fetch("/api/quote-sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buyer: address,
          stake: stakeAmount.toString(),
          legs,
        }),
      });
      if (!quoteRes.ok) {
        const msg = await quoteRes.text();
        throw new Error(`Quote sign failed: ${msg}`);
      }
      const { quote, signature } = (await quoteRes.json()) as {
        quote: {
          buyer: `0x${string}`;
          stake: string;
          legs: Array<{
            sourceRef: string;
            outcome: `0x${string}`;
            probabilityPPM: string;
            cutoffTime: string;
            earliestResolve: string;
            oracleAdapter: `0x${string}`;
          }>;
          deadline: string;
          nonce: string;
        };
        signature: `0x${string}`;
      };

      // Approve exact amount
      const approveHash = await writeContractAsync({
        address: usdc.address,
        abi: usdc.abi,
        functionName: "approve",
        args: [engine.address, stakeAmount],
        dataSuffix: BUILDER_SUFFIX,
      });
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status === "reverted") {
        throw new Error("Approve transaction reverted on-chain");
      }

      setIsPending(false);
      setIsConfirming(true);

      const quoteArg = {
        buyer: quote.buyer,
        stake: BigInt(quote.stake),
        legs: quote.legs.map((l) => ({
          sourceRef: l.sourceRef,
          outcome: l.outcome,
          probabilityPPM: BigInt(l.probabilityPPM),
          cutoffTime: BigInt(l.cutoffTime),
          earliestResolve: BigInt(l.earliestResolve),
          oracleAdapter: l.oracleAdapter,
        })),
        deadline: BigInt(quote.deadline),
        nonce: BigInt(quote.nonce),
      };

      const buyHash = await writeContractAsync({
        address: engine.address,
        abi: engine.abi,
        functionName: "buyTicketSigned",
        args: [quoteArg, signature],
        dataSuffix: BUILDER_SUFFIX,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });

      if (receipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }

      // Parse TicketPurchased event from receipt to get the actual ticket ID.
      // Cast the decoded args because the generated ABI is not `as const`, so
      // viem cannot infer per-event arg types from a widened `Abi`.
      let newTicketId: bigint | undefined;
      try {
        const purchaseEvents = parseEventLogs({
          abi: engine.abi,
          logs: receipt.logs,
          eventName: "TicketPurchased",
        });
        newTicketId = (purchaseEvents[0]?.args as { ticketId?: bigint } | undefined)?.ticketId;
      } catch {
        // ABI mismatch or unexpected log format -- fall through to fallback
      }

      // Fallback: read ticketCount post-confirmation (less reliable but works
      // if event ABI drifts from contract)
      if (newTicketId === undefined && publicClient) {
        const count = await publicClient.readContract({
          address: engine.address,
          abi: engine.abi,
          functionName: "ticketCount",
        });
        newTicketId = (count as bigint) - 1n;
      }

      setIsConfirming(false);
      setIsSuccess(true);
      setLastTicketId(newTicketId ?? null);
      return true;
    } catch (err) {
      console.error("Buy ticket failed:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      setIsPending(false);
      setIsConfirming(false);
    }
  };

  return {
    buyTicket,
    resetSuccess,
    isPending,
    isConfirming,
    isSuccess,
    error,
    lastTicketId,
  };
}

export function useDepositVault() {
  const { address } = useAccount();
  const publicClient = useContractClient();
  const chainId = usePinnedChainId();
  const usdc = useDeployedContract("MockUSDC", { chainId });
  const vault = useDeployedContract("HouseVault", { chainId });
  const { writeContractAsync } = useWriteContract();
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const deposit = async (amountUsdc: number): Promise<boolean> => {
    if (!address || !publicClient || !usdc || !vault) return false;

    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);

    try {
      const amount = parseUnits(amountUsdc.toString(), 6);

      // Approve exact amount
      const approveHash = await writeContractAsync({
        address: usdc.address,
        abi: usdc.abi,
        functionName: "approve",
        args: [vault.address, amount],
        dataSuffix: BUILDER_SUFFIX,
      });
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status === "reverted") {
        throw new Error("Approve transaction reverted on-chain");
      }

      // Deposit into vault
      setIsPending(false);
      setIsConfirming(true);
      const depositHash = await writeContractAsync({
        address: vault.address,
        abi: vault.abi,
        functionName: "deposit",
        args: [amount, address],
        dataSuffix: BUILDER_SUFFIX,
      });
      const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
      if (depositReceipt.status === "reverted") {
        throw new Error("Deposit transaction reverted on-chain");
      }

      setIsConfirming(false);
      setIsSuccess(true);
      return true;
    } catch (err) {
      console.error("Deposit failed:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      setIsPending(false);
      setIsConfirming(false);
    }
  };

  const resetSuccess = () => { setIsSuccess(false); setError(null); };

  return { deposit, resetSuccess, isPending, isConfirming, isSuccess, error };
}

export function useWithdrawVault() {
  const { address } = useAccount();
  const publicClient = useContractClient();
  const chainId = usePinnedChainId();
  const vault = useDeployedContract("HouseVault", { chainId });
  const { writeContractAsync } = useWriteContract();
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const withdraw = async (amountUsdc: number): Promise<boolean> => {
    if (!address || !publicClient || !vault) return false;

    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);

    try {
      const amount = parseUnits(amountUsdc.toString(), 6);

      setIsPending(false);
      setIsConfirming(true);
      const withdrawHash = await writeContractAsync({
        address: vault.address,
        abi: vault.abi,
        functionName: "withdraw",
        args: [amount, address],
        dataSuffix: BUILDER_SUFFIX,
      });
      const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
      if (withdrawReceipt.status === "reverted") {
        throw new Error("Withdraw transaction reverted on-chain");
      }

      setIsConfirming(false);
      setIsSuccess(true);
      return true;
    } catch (err) {
      console.error("Withdraw failed:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      setIsPending(false);
      setIsConfirming(false);
    }
  };

  const resetSuccess = () => { setIsSuccess(false); setError(null); };

  return { withdraw, resetSuccess, isPending, isConfirming, isSuccess, error };
}

export function useSettleTicket() {
  const publicClient = useContractClient();
  const chainId = usePinnedChainId();
  const engine = useDeployedContract("ParlayEngine", { chainId });
  const { writeContractAsync } = useWriteContract();
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
  const chainId = usePinnedChainId();
  const engine = useDeployedContract("ParlayEngine", { chainId });
  const { writeContractAsync } = useWriteContract();
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
  const chainId = usePinnedChainId();
  const engine = useDeployedContract("ParlayEngine", { chainId });
  const { writeContractAsync } = useWriteContract();
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

// ---- Lock Vault hooks ----

export interface LockPosition {
  owner: `0x${string}`;
  shares: bigint;
  tier: number;
  lockedAt: bigint;
  unlockAt: bigint;
  feeMultiplierBps: bigint;
  rewardDebt: bigint;
}

export function useLockVault() {
  const { address } = useAccount();
  const publicClient = useContractClient();
  const chainId = usePinnedChainId();
  const vault = useDeployedContract("HouseVault", { chainId });
  const lockVault = useDeployedContract("LockVault", { chainId });
  const { writeContractAsync } = useWriteContract();
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const lock = async (shares: bigint, tier: number): Promise<boolean> => {
    if (!address || !publicClient || !vault || !lockVault) return false;

    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);

    try {
      // Approve exact vUSDC transfer to lockVault (ERC20 approve on the vault
      // share token which is the HouseVault contract itself).
      const approveHash = await writeContractAsync({
        address: vault.address,
        abi: vault.abi,
        functionName: "approve",
        args: [lockVault.address, shares],
        dataSuffix: BUILDER_SUFFIX,
      });
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status === "reverted") {
        throw new Error("Approve transaction reverted on-chain");
      }

      // Lock shares
      setIsPending(false);
      setIsConfirming(true);
      const lockHash = await writeContractAsync({
        address: lockVault.address,
        abi: lockVault.abi,
        functionName: "lock",
        args: [shares, tier],
        dataSuffix: BUILDER_SUFFIX,
      });
      const lockReceipt = await publicClient.waitForTransactionReceipt({ hash: lockHash });
      if (lockReceipt.status === "reverted") {
        throw new Error("Lock transaction reverted on-chain");
      }

      setIsConfirming(false);
      setIsSuccess(true);
      return true;
    } catch (err) {
      console.error("Lock failed:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      setIsPending(false);
      setIsConfirming(false);
    }
  };

  return { lock, isPending, isConfirming, isSuccess, error };
}

export function useUnlockVault() {
  const publicClient = useContractClient();
  const chainId = usePinnedChainId();
  const lockVault = useDeployedContract("LockVault", { chainId });
  const { writeContractAsync } = useWriteContract();
  const [isPending, setIsPending] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const unlock = async (positionId: bigint) => {
    if (!publicClient || !lockVault) return;

    setIsPending(true);
    setIsSuccess(false);
    setError(null);

    try {
      const hash = await writeContractAsync({
        address: lockVault.address,
        abi: lockVault.abi,
        functionName: "unlock",
        args: [positionId],
        dataSuffix: BUILDER_SUFFIX,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        throw new Error("Unlock transaction reverted on-chain");
      }
      setIsSuccess(true);
    } catch (err) {
      console.error("Unlock failed:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsPending(false);
    }
  };

  return { unlock, isPending, isSuccess, error };
}

export function useEarlyWithdraw() {
  const publicClient = useContractClient();
  const chainId = usePinnedChainId();
  const lockVault = useDeployedContract("LockVault", { chainId });
  const { writeContractAsync } = useWriteContract();
  const [isPending, setIsPending] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const earlyWithdraw = async (positionId: bigint) => {
    if (!publicClient || !lockVault) return;

    setIsPending(true);
    setIsSuccess(false);
    setError(null);

    try {
      const hash = await writeContractAsync({
        address: lockVault.address,
        abi: lockVault.abi,
        functionName: "earlyWithdraw",
        args: [positionId],
        dataSuffix: BUILDER_SUFFIX,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        throw new Error("Early withdraw transaction reverted on-chain");
      }
      setIsSuccess(true);
    } catch (err) {
      console.error("Early withdraw failed:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsPending(false);
    }
  };

  return { earlyWithdraw, isPending, isSuccess, error };
}

export function useLockPositions() {
  const { address } = useAccount();
  const publicClient = useContractClient();
  const chainId = usePinnedChainId();
  const lockVault = useDeployedContract("LockVault", { chainId });
  const [positions, setPositions] = useState<{ id: bigint; position: LockPosition }[]>([]);
  const [userTotalLocked, setUserTotalLocked] = useState(0n);
  const [isLoading, setIsLoading] = useState(true);
  const fetchIdRef = useRef(0);
  const inFlightRef = useRef(false);

  const fetchPositions = useCallback(async () => {
    if (!address || !publicClient || !lockVault) {
      ++fetchIdRef.current;
      inFlightRef.current = false;
      setPositions([]);
      setUserTotalLocked(0n);
      setIsLoading(false);
      return;
    }

    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const localFetchId = ++fetchIdRef.current;

    try {
      const nextId = await publicClient.readContract({
        address: lockVault.address,
        abi: lockVault.abi,
        functionName: "nextPositionId",
      });

      if (localFetchId !== fetchIdRef.current) return;

      const total = Number(nextId as bigint);
      const userPositions: { id: bigint; position: LockPosition }[] = [];

      for (let i = 0; i < total; i++) {
        if (localFetchId !== fetchIdRef.current) return;
        try {
          const data = await publicClient.readContract({
            address: lockVault.address,
            abi: lockVault.abi,
            functionName: "positions",
            args: [BigInt(i)],
          });

          const pos = data as [string, bigint, number, bigint, bigint, bigint, bigint];
          if (pos[0].toLowerCase() === address.toLowerCase() && pos[1] > 0n) {
            userPositions.push({
              id: BigInt(i),
              position: {
                owner: pos[0] as `0x${string}`,
                shares: pos[1],
                tier: pos[2],
                lockedAt: pos[3],
                unlockAt: pos[4],
                feeMultiplierBps: pos[5],
                rewardDebt: pos[6],
              },
            });
          }
        } catch {
          // skip
        }
      }

      if (localFetchId !== fetchIdRef.current) return;
      setPositions(userPositions);
      setUserTotalLocked(userPositions.reduce((sum, { position }) => sum + position.shares, 0n));
    } catch (err) {
      if (localFetchId !== fetchIdRef.current) return;
      console.error("Failed to fetch lock positions:", err);
    } finally {
      if (localFetchId === fetchIdRef.current) {
        inFlightRef.current = false;
        setIsLoading(false);
      }
    }
  }, [address, publicClient, lockVault?.address]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchPositions();
    const interval = setInterval(fetchPositions, 10000);
    return () => clearInterval(interval);
  }, [fetchPositions]);

  return { positions, userTotalLocked, isLoading, refetch: fetchPositions };
}

export function useLockStats() {
  const { address } = useAccount();
  const chainId = usePinnedChainId();
  const lockVault = useDeployedContract("LockVault", { chainId });

  const totalLockedResult = useReadContract({
    address: lockVault?.address,
    abi: lockVault?.abi ?? EMPTY_ABI,
    functionName: "totalLockedShares",
    query: { enabled: !!lockVault, refetchInterval: 10000 },
  });

  const pendingRewardsResult = useReadContract({
    address: lockVault?.address,
    abi: lockVault?.abi ?? EMPTY_ABI,
    functionName: "pendingRewards",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!lockVault, refetchInterval: 10000 },
  });

  return {
    totalLocked: totalLockedResult.data as bigint | undefined,
    pendingRewards: pendingRewardsResult.data as bigint | undefined,
    isLoading: totalLockedResult.isLoading,
    refetch: () => {
      totalLockedResult.refetch();
      pendingRewardsResult.refetch();
    },
  };
}
