"use client";

import { useEffect, useRef, useState } from "react";
import { usePinnedChainId } from "./_internal";
import { useUSDCBalance } from "./usdc";
import { parseUnits } from "viem";
import { useAccount, useBalance } from "wagmi";
import { LOCAL_CHAIN_ID } from "~~/utils/parlay";

// Anvil's higher base fee burns through a 0.005 ETH drip in a couple of txs,
// so we drip 0.05 there and gate the claim button until the wallet drops back
// under 0.05. Base Sepolia stays at the original 0.001 threshold + 0.005 drip.
const ETH_THRESHOLD_LOCAL = parseUnits("0.05", 18);
const ETH_THRESHOLD_DEFAULT = parseUnits("0.001", 18);
const USDC_THRESHOLD = parseUnits("1000", 6);

export interface OnboardingProgress {
  walletInstalled: boolean;
  walletConnected: boolean;
  onCorrectChain: boolean;
  hasGas: boolean;
  hasUsdc: boolean;
  completed: boolean;
  /** Steps 1-3 satisfied — user can enter the app without funds. */
  canEnter: boolean;
  /** Avoids SSR rendering optimistic green checks for walletInstalled. */
  hydrated: boolean;
}

export function useOnboardingProgress(): OnboardingProgress {
  const { isConnected, address, chainId: walletChainId } = useAccount();
  const pinnedChainId = usePinnedChainId();
  const [walletInstalled, setWalletInstalled] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const w = window as unknown as { ethereum?: unknown };
    setWalletInstalled(typeof w.ethereum !== "undefined");
    setHydrated(true);
  }, []);

  const { data: ethBalance } = useBalance({
    address,
    chainId: pinnedChainId,
    query: { enabled: !!address, refetchInterval: 5000 },
  });
  const { balance: usdcBalance } = useUSDCBalance();

  const onCorrectChain = isConnected && walletChainId === pinnedChainId;
  const ethThreshold = pinnedChainId === LOCAL_CHAIN_ID ? ETH_THRESHOLD_LOCAL : ETH_THRESHOLD_DEFAULT;
  const hasGas = (ethBalance?.value ?? 0n) >= ethThreshold;
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

export interface UseClaimGasEthReturn {
  claim: () => Promise<void>;
  isPending: boolean;
  isSuccess: boolean;
  error: string | null;
}

/** Posts to /api/onboarding/claim-eth, which relays a small ETH transfer from
 *  a server-funded wallet (anvil#0 locally, HOT_SIGNER on testnet). Drip size
 *  is chain-specific — see DRIP_AMOUNT in the route handler. */
export function useClaimGasEth(): UseClaimGasEthReturn {
  const { address } = useAccount();
  const [isPending, setIsPending] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const claim = async () => {
    if (!address) {
      setError("Wallet not connected");
      return;
    }
    setIsPending(true);
    setIsSuccess(false);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/claim-eth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const json = (await res.json()) as { ok?: boolean; txHash?: string; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Drip failed");
        return;
      }
      setIsSuccess(true);
      clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setIsSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Drip failed");
    } finally {
      setIsPending(false);
    }
  };

  useEffect(() => () => clearTimeout(successTimerRef.current), []);

  return { claim, isPending, isSuccess, error };
}
