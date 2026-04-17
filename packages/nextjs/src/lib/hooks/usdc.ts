"use client";

import { useState, useEffect, useRef } from "react";
import { useAccount, useReadContract, usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { BUILDER_SUFFIX } from "../builder-code";
import { useDeployedContract } from "../../hooks/useDeployedContract";
import { EMPTY_ABI, usePinnedWriteContract } from "./_internal";

export function useUSDCBalance() {
  const { address } = useAccount();
  const usdc = useDeployedContract("MockUSDC");

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

/** Mint MockUSDC to the connected wallet (testnet only, 10k max per call). */
export function useMintTestUSDC() {
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const usdc = useDeployedContract("MockUSDC");
  const { writeContractAsync } = usePinnedWriteContract();
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
