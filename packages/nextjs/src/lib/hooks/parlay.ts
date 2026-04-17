"use client";

import { useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { parseUnits, parseEventLogs } from "viem";
import { BUILDER_SUFFIX } from "../builder-code";
import { useDeployedContract } from "../../hooks/useDeployedContract";
import { EMPTY_ABI, useContractClient, usePinnedWriteContract } from "./_internal";

export function useParlayConfig() {
  const engine = useDeployedContract("ParlayEngine");
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
