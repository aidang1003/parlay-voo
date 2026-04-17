"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount, useReadContract } from "wagmi";
import { BUILDER_SUFFIX } from "../builder-code";
import { useDeployedContract } from "../../hooks/useDeployedContract";
import { EMPTY_ABI, useContractClient, usePinnedWriteContract } from "./_internal";

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
  const vault = useDeployedContract("HouseVault");
  const lockVault = useDeployedContract("LockVault");
  const { writeContractAsync } = usePinnedWriteContract();
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
  const lockVault = useDeployedContract("LockVault");
  const { writeContractAsync } = usePinnedWriteContract();
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
  const lockVault = useDeployedContract("LockVault");
  const { writeContractAsync } = usePinnedWriteContract();
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
  const lockVault = useDeployedContract("LockVault");
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
  const lockVault = useDeployedContract("LockVault");

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
