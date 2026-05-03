"use client";

import {useEffect, useMemo, useRef, useState} from "react";
import type {Abi} from "viem";
import {parseUnits} from "viem";
import {useAccount, useBalance, useReadContract} from "wagmi";
import deployedContracts from "../../contracts/deployedContracts";
import {BUILDER_SUFFIX} from "../builder-code";
import {EMPTY_ABI, usePinnedChainId, usePinnedWriteContract} from "./_internal";
import {useUSDCBalance} from "./usdc";

/** Runtime lookup that tolerates the faucet not being deployed yet on the
 *  active chain. Doesn't go through `useDeployedContract`'s typed API because
 *  `OnboardingFaucet` is absent from `deployedContracts.ts` until the first
 *  `pnpm deploy:faucet:*` run. Once present, it's picked up automatically. */
function useFaucetContract(): {address: `0x${string}`; abi: Abi} | undefined {
  const chainId = usePinnedChainId();
  return useMemo(() => {
    const entry = (deployedContracts as Record<number, Record<string, {address: `0x${string}`; abi: Abi}>>)[chainId];
    return entry?.OnboardingFaucet;
  }, [chainId]);
}

const ETH_THRESHOLD = parseUnits("0.001", 18);
const USDC_THRESHOLD = parseUnits("1000", 6);

/** Flags reflecting whether the connected wallet has cleared each prerequisite. */
export interface OnboardingProgress {
  walletInstalled: boolean;
  walletConnected: boolean;
  onCorrectChain: boolean;
  hasGas: boolean;
  hasUsdc: boolean;
  /** All five prerequisites satisfied. */
  completed: boolean;
  /** Steps 1-3 satisfied — the user can use the app even without funds. */
  canEnter: boolean;
  /** Becomes true after first client render so the page does not render
   *  optimistic green checks for `walletInstalled` during SSR. */
  hydrated: boolean;
}

export function useOnboardingProgress(): OnboardingProgress {
  const {isConnected, address, chainId: walletChainId} = useAccount();
  const pinnedChainId = usePinnedChainId();
  const [walletInstalled, setWalletInstalled] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const w = window as unknown as {ethereum?: unknown};
    setWalletInstalled(typeof w.ethereum !== "undefined");
    setHydrated(true);
  }, []);

  const {data: ethBalance} = useBalance({
    address,
    chainId: pinnedChainId,
    query: {enabled: !!address, refetchInterval: 5000},
  });
  const {balance: usdcBalance} = useUSDCBalance();

  const onCorrectChain = isConnected && walletChainId === pinnedChainId;
  const hasGas = (ethBalance?.value ?? 0n) >= ETH_THRESHOLD;
  const hasUsdc = (usdcBalance ?? 0n) >= USDC_THRESHOLD;
  const canEnter = walletInstalled && isConnected && onCorrectChain;
  const completed = canEnter && hasGas && hasUsdc;

  return {
    walletInstalled,
    walletConnected: isConnected,
    onCorrectChain,
    hasGas,
    hasUsdc,
    completed,
    canEnter,
    hydrated,
  };
}

interface FaucetTxState {
  isPending: boolean;
  isConfirming: boolean;
  isSuccess: boolean;
  error: string | null;
}

export interface UseOnboardingFaucetReturn extends FaucetTxState {
  claimEth: () => Promise<void>;
  claimUsdc: () => Promise<void>;
  /** Faucet contract is deployed on the active chain. False on chains where
   *  the faucet was not deployed (e.g. fresh Anvil) — UI falls back to the
   *  in-app mint button or anvil_setBalance for ETH. */
  available: boolean;
  canClaimEth: boolean;
  canClaimUsdc: boolean;
  /** Unix seconds when the next USDC claim becomes available, or null. */
  nextUsdcClaimAt: number | null;
}

/** Wraps `OnboardingFaucet.claimEth` / `claimUsdc` plus the per-address state
 *  reads needed to gate the buttons (one-shot ETH, 24h USDC cooldown). */
export function useOnboardingFaucet(): UseOnboardingFaucetReturn {
  const {address} = useAccount();
  const faucet = useFaucetContract();
  const {writeContractAsync} = usePinnedWriteContract();

  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const enabled = !!faucet && !!address;

  const ethClaimedQuery = useReadContract({
    address: faucet?.address,
    abi: faucet?.abi ?? EMPTY_ABI,
    functionName: "ethClaimed",
    args: address ? [address] : undefined,
    query: {enabled, refetchInterval: 5000},
  });

  const lastUsdcClaimQuery = useReadContract({
    address: faucet?.address,
    abi: faucet?.abi ?? EMPTY_ABI,
    functionName: "lastUsdcClaim",
    args: address ? [address] : undefined,
    query: {enabled, refetchInterval: 5000},
  });

  const cooldownQuery = useReadContract({
    address: faucet?.address,
    abi: faucet?.abi ?? EMPTY_ABI,
    functionName: "usdcCooldown",
    query: {enabled: !!faucet, staleTime: 60_000},
  });

  const ethClaimed = (ethClaimedQuery.data as boolean | undefined) ?? false;
  const lastUsdcClaim = (lastUsdcClaimQuery.data as bigint | undefined) ?? 0n;
  const cooldown = (cooldownQuery.data as bigint | undefined) ?? 86_400n;
  const nextUsdcClaimAt = lastUsdcClaim === 0n ? null : Number(lastUsdcClaim + cooldown);
  const now = Math.floor(Date.now() / 1000);
  const canClaimEth = enabled && !ethClaimed;
  const canClaimUsdc = enabled && (nextUsdcClaimAt === null || now >= nextUsdcClaimAt);

  const refetchAll = () => {
    ethClaimedQuery.refetch();
    lastUsdcClaimQuery.refetch();
  };

  const runClaim = async (functionName: "claimEth" | "claimUsdc") => {
    if (!faucet) {
      setError("Faucet is not deployed on this network");
      return;
    }
    setIsPending(true);
    setIsConfirming(false);
    setIsSuccess(false);
    setError(null);
    try {
      const hash = await writeContractAsync({
        address: faucet.address,
        abi: faucet.abi,
        functionName,
        args: [],
        dataSuffix: BUILDER_SUFFIX,
      });
      setIsPending(false);
      setIsConfirming(true);
      // Best-effort wait — refetch the read state regardless of receipt status
      // so a re-broadcasted tx still flips the buttons once the chain catches up.
      setTimeout(refetchAll, 1500);
      setIsConfirming(false);
      setIsSuccess(true);
      void hash;
      clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setIsSuccess(false), 3000);
    } catch (err) {
      setIsPending(false);
      setIsConfirming(false);
      const msg = err instanceof Error ? err.message : "Faucet claim failed";
      if (msg.includes("AlreadyClaimedEth")) setError("This wallet already claimed test ETH");
      else if (msg.includes("UsdcCooldownActive")) setError("Try again later — USDC drip is on cooldown");
      else if (msg.includes("FaucetEmpty")) setError("Faucet is being refilled — try again later");
      else setError(msg);
    }
  };

  useEffect(() => () => clearTimeout(successTimerRef.current), []);

  return {
    claimEth: () => runClaim("claimEth"),
    claimUsdc: () => runClaim("claimUsdc"),
    available: !!faucet,
    canClaimEth,
    canClaimUsdc,
    nextUsdcClaimAt,
    isPending,
    isConfirming,
    isSuccess,
    error,
  };
}
