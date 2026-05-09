"use client";

import { useState } from "react";
import { BUILDER_SUFFIX } from "../builder-code";
import { fetchSignedQuote, toQuoteArg } from "../quote/sign-fetch";
import { EMPTY_ABI, useContractClient, usePinnedWriteContract } from "./_internal";
import { useDeployedContract } from "./useDeployedContract";
import { encodeFunctionData, parseEventLogs, parseUnits } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { ceilToCentRaw } from "~~/utils/parlay";

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
  const corrRes = data?.[3]?.status === "success" ? (data[3].result as readonly [bigint, bigint, bigint]) : undefined;

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
    stakeUsdc: number,
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

      // Wait for the approve's state change to be visible to the RPC node
      // serving simulateContract. waitForTransactionReceipt confirms the tx
      // landed but a load-balanced RPC pool can serve eth_call from a peer
      // node that's a block or two behind, producing a spurious
      // ERC20InsufficientAllowance revert during the simulate below.
      const ALLOWANCE_POLL_ATTEMPTS = 6;
      const ALLOWANCE_POLL_DELAY_MS = 350;
      for (let attempt = 0; attempt < ALLOWANCE_POLL_ATTEMPTS; attempt++) {
        const current = (await publicClient.readContract({
          address: usdc.address,
          abi: usdc.abi,
          functionName: "allowance",
          args: [address, engine.address],
        })) as bigint;
        if (current >= stakeAmount) {
          if (attempt > 0) {
            console.log(`[buyTicket] allowance caught up after ${attempt} retries (${current}/${stakeAmount})`);
          }
          break;
        }
        if (attempt === ALLOWANCE_POLL_ATTEMPTS - 1) {
          console.warn(
            `[buyTicket] allowance still stale after ${ALLOWANCE_POLL_ATTEMPTS} polls ` +
              `(saw ${current}, need ${stakeAmount}); proceeding anyway — wallet RPC may be fresher`,
          );
          break;
        }
        await new Promise(r => setTimeout(r, ALLOWANCE_POLL_DELAY_MS));
      }

      setIsPending(false);
      setIsConfirming(true);

      const quoteArg = toQuoteArg(quote);

      // Pre-flight log + simulate so a chain revert surfaces with its actual
      // reason ("ParlayEngine: cutoff passed", "deadline passed", etc.)
      // instead of the opaque "Transaction reverted on-chain". The cutoff
      // delta in particular is what's been biting us — surfaced here in
      // human-readable form before we burn the gas.
      const nowSec = Math.floor(Date.now() / 1000);
      console.log("[buyTicket] submitting signed quote", {
        buyer: quote.buyer,
        stake: quote.stake.toString(),
        deadline: quote.deadline.toString(),
        deadlineDelta: Number(quote.deadline) - nowSec,
        legs: quote.legs.map(l => ({
          sourceRef: l.sourceRef.slice(0, 14) + "…",
          probabilityPPM: l.probabilityPPM.toString(),
          cutoffTime: l.cutoffTime.toString(),
          cutoffIso: new Date(Number(l.cutoffTime) * 1000).toISOString(),
          cutoffDeltaSec: Number(l.cutoffTime) - nowSec,
        })),
      });

      try {
        await publicClient.simulateContract({
          address: engine.address,
          abi: engine.abi,
          functionName: "buyTicketSigned",
          args: [quoteArg, signature],
          account: address,
        });
      } catch (simErr) {
        console.error("[buyTicket] simulate failed — chain would revert:", simErr);
        throw simErr;
      }

      const buyHash = await writeContractAsync({
        address: engine.address,
        abi: engine.abi,
        functionName: "buyTicketSigned",
        args: [quoteArg, signature],
        dataSuffix: BUILDER_SUFFIX,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });

      if (receipt.status === "reverted") {
        // Receipt-level revert without a simulate-time failure is rare
        // (re-entrancy guard, block-level race). Fall back to a tx replay so
        // the underlying reason still makes it into the error message.
        let reason = "unknown reason";
        try {
          await publicClient.call({
            account: address,
            to: engine.address,
            data: encodeFunctionData({
              abi: engine.abi,
              functionName: "buyTicketSigned",
              args: [quoteArg, signature],
            }),
            blockNumber: receipt.blockNumber,
          });
        } catch (replayErr) {
          reason = replayErr instanceof Error ? replayErr.message : String(replayErr);
        }
        throw new Error(`Transaction reverted on-chain: ${reason}`);
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
    stakeUsdc: number,
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
