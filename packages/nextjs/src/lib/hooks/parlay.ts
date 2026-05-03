"use client";

import { useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { parseUnits, parseEventLogs } from "viem";
import { ceilToCentRaw } from "@parlayvoo/shared";
import { BUILDER_SUFFIX } from "../builder-code";
import { fetchSignedQuote, toQuoteArg } from "../quote/sign-fetch";
import { useDeployedContract } from "./useDeployedContract";
import { EMPTY_ABI, useContractClient, usePinnedWriteContract } from "./_internal";

export function useParlayConfig() {
  const engine = useDeployedContract("ParlayEngine");
  const vault = useDeployedContract("HouseVault");
  const baseEngine = { address: engine?.address, abi: engine?.abi ?? EMPTY_ABI } as const;
  const baseVault = { address: vault?.address, abi: vault?.abi ?? EMPTY_ABI } as const;

  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      { ...baseEngine, functionName: "protocolFeeBps" },
      { ...baseEngine, functionName: "minStake" },
      { ...baseEngine, functionName: "maxLegs" },
      { ...baseVault, functionName: "corrConfig" },
    ],
    query: { enabled: !!engine && !!vault, refetchInterval: 10000 },
  });

  const protocolFeeRes = data?.[0]?.status === "success" ? (data[0].result as bigint) : undefined;
  const minStakeRes = data?.[1]?.status === "success" ? (data[1].result as bigint) : undefined;
  const maxLegsRes = data?.[2]?.status === "success" ? (data[2].result as bigint) : undefined;
  const corrRes =
    data?.[3]?.status === "success"
      ? (data[3].result as readonly [bigint, bigint, bigint])
      : undefined;

  return {
    protocolFeeBps: protocolFeeRes !== undefined ? Number(protocolFeeRes) : undefined,
    correlationAsymptoteBps: corrRes !== undefined ? Number(corrRes[0]) : undefined,
    correlationHalfSatPpm: corrRes !== undefined ? Number(corrRes[1]) : undefined,
    maxLegsPerGroup: corrRes !== undefined ? Number(corrRes[2]) : undefined,
    maxLegs: maxLegsRes !== undefined ? Number(maxLegsRes) : undefined,
    minStakeUSDC: minStakeRes !== undefined ? Number(minStakeRes) / 1e6 : undefined,
    isLoading,
    refetch,
  };
}

export function useBuyTicket() {
  const publicClient = useContractClient();
  const { address } = useAccount();
  const usdc = useDeployedContract("MockUSDC");
  const engine = useDeployedContract("ParlayEngine");
  const { writeContractAsync } = usePinnedWriteContract();
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

      const { quote, signature } = await fetchSignedQuote(address, stakeAmount, legs);

      // round approval up so sub-cent drift can't starve engine's safeTransferFrom
      const approveAmount = ceilToCentRaw(stakeAmount);
      const approveHash = await writeContractAsync({
        address: usdc.address,
        abi: usdc.abi,
        functionName: "approve",
        args: [engine.address, approveAmount],
        dataSuffix: BUILDER_SUFFIX,
      });
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status === "reverted") {
        throw new Error("Approve transaction reverted on-chain");
      }

      setIsPending(false);
      setIsConfirming(true);

      const buyHash = await writeContractAsync({
        address: engine.address,
        abi: engine.abi,
        functionName: "buyTicketSigned",
        args: [toQuoteArg(quote), signature],
        dataSuffix: BUILDER_SUFFIX,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });

      if (receipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }

      // cast decoded args — generated ABI isn't `as const`, viem can't infer event types
      const purchaseEvents = parseEventLogs({
        abi: engine.abi,
        logs: receipt.logs,
        eventName: "TicketPurchased",
      });
      const newTicketId = (purchaseEvents[0]?.args as { ticketId?: bigint } | undefined)?.ticketId;

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

/** Spends promo credit, no USDC. Wins mint PARTIAL lock; losses burn credit. */
export function useBuyLosslessParlay() {
  const publicClient = useContractClient();
  const { address } = useAccount();
  const engine = useDeployedContract("ParlayEngine");
  const { writeContractAsync } = usePinnedWriteContract();
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

  const buyLossless = async (
    legs: Array<{ sourceRef: string; side: "yes" | "no" }>,
    stakeUsdc: number
  ): Promise<boolean> => {
    if (!address || !publicClient || !engine) return false;

    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);

    try {
      const stakeAmount = parseUnits(stakeUsdc.toString(), 6);

      const { quote, signature } = await fetchSignedQuote(address, stakeAmount, legs);

      setIsPending(false);
      setIsConfirming(true);

      const buyHash = await writeContractAsync({
        address: engine.address,
        abi: engine.abi,
        functionName: "buyLosslessParlay",
        args: [toQuoteArg(quote), signature],
        dataSuffix: BUILDER_SUFFIX,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });

      if (receipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }

      const purchaseEvents = parseEventLogs({
        abi: engine.abi,
        logs: receipt.logs,
        eventName: "TicketPurchased",
      });
      const newTicketId = (purchaseEvents[0]?.args as { ticketId?: bigint } | undefined)?.ticketId;

      setIsConfirming(false);
      setIsSuccess(true);
      setLastTicketId(newTicketId ?? null);
      return true;
    } catch (err) {
      console.error("Buy lossless parlay failed:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      setIsPending(false);
      setIsConfirming(false);
    }
  };

  return {
    buyLossless,
    resetSuccess,
    isPending,
    isConfirming,
    isSuccess,
    error,
    lastTicketId,
  };
}
