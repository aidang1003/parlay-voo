"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount, useReadContract } from "wagmi";
import { BUILDER_SUFFIX } from "../builder-code";
import { useDeployedContract } from "./useDeployedContract";
import { EMPTY_ABI, useContractClient, usePinnedWriteContract } from "./_internal";

/** On-chain tier enum mirrored from `ILockVault.Tier`. */
export enum LockTier {
  FULL = 0,
  PARTIAL = 1,
  LEAST = 2,
}

export interface LockPosition {
  owner: `0x${string}`;
  shares: bigint;
  duration: bigint;
  lockedAt: bigint;
  unlockAt: bigint;
  feeShareBps: bigint;
  rewardDebt: bigint;
  tier: LockTier;
}

export function useLockVault() {
  const { address } = useAccount();
  const publicClient = useContractClient();
  const vault = useDeployedContract("HouseVault");
  const lockVault = useDeployedContract("LockVaultV2");
  const { writeContractAsync } = usePinnedWriteContract();
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // False when LockVaultV2 isn't deployed on the active chain (e.g. Sepolia
  // broadcast pre-dates the V2 rollout). The UI uses this to disable the
  // submit button with a clear label instead of silently no-oping.
  const ready = !!vault && !!lockVault;

  const lock = async (shares: bigint, durationSecs: bigint): Promise<boolean> => {
    if (!address || !publicClient || !vault || !lockVault) return false;

    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);

    try {
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

      setIsPending(false);
      setIsConfirming(true);
      const lockHash = await writeContractAsync({
        address: lockVault.address,
        abi: lockVault.abi,
        functionName: "lock",
        args: [shares, durationSecs],
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

  return { lock, isPending, isConfirming, isSuccess, error, ready };
}

export function useUnlockVault() {
  const publicClient = useContractClient();
  const lockVault = useDeployedContract("LockVaultV2");
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

export function useGraduate() {
  const publicClient = useContractClient();
  const lockVault = useDeployedContract("LockVaultV2");
  const { writeContractAsync } = usePinnedWriteContract();
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const graduate = async (positionId: bigint, newDurationSecs: bigint): Promise<boolean> => {
    if (!publicClient || !lockVault) return false;

    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);

    try {
      const hash = await writeContractAsync({
        address: lockVault.address,
        abi: lockVault.abi,
        functionName: "graduate",
        args: [positionId, newDurationSecs],
        dataSuffix: BUILDER_SUFFIX,
      });
      setIsPending(false);
      setIsConfirming(true);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        throw new Error("Graduate transaction reverted on-chain");
      }
      setIsSuccess(true);
      return true;
    } catch (err) {
      console.error("Graduate failed:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      return false;
    } finally {
      setIsPending(false);
      setIsConfirming(false);
    }
  };

  return { graduate, isPending, isConfirming, isSuccess, error };
}

export function useEarlyWithdraw() {
  const publicClient = useContractClient();
  const lockVault = useDeployedContract("LockVaultV2");
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
  const lockVault = useDeployedContract("LockVaultV2");
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

          const pos = data as [
            string,
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
            number,
          ];
          if (pos[0].toLowerCase() === address.toLowerCase() && pos[1] > 0n) {
            userPositions.push({
              id: BigInt(i),
              position: {
                owner: pos[0] as `0x${string}`,
                shares: pos[1],
                duration: pos[2],
                lockedAt: pos[3],
                unlockAt: pos[4],
                feeShareBps: pos[5],
                rewardDebt: pos[6],
                tier: pos[7] as LockTier,
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
  const lockVault = useDeployedContract("LockVaultV2");

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
