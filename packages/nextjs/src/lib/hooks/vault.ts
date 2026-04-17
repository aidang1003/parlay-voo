"use client";

import { useState } from "react";
import { useAccount, useReadContracts, useWriteContract } from "wagmi";
import { parseUnits } from "viem";
import { BUILDER_SUFFIX } from "../builder-code";
import { useDeployedContract } from "../../hooks/useDeployedContract";
import { EMPTY_ABI, useContractClient, usePinnedChainId } from "./_internal";

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
