"use client";

import { useCallback, useState } from "react";
import type { SupportedDeployedChainId } from "../../contracts/deployedContractTypes";
import { BUILDER_SUFFIX } from "../builder-code";
import type { Abi } from "viem";
import { useChainId, usePublicClient, useWriteContract } from "wagmi";

/**
 * Resolves the chain this app reads AND writes against: `NEXT_PUBLIC_CHAIN_ID`
 * if set (production/local pin), else the wallet's active chain. Pinning both
 * sides prevents the "wallet on Base Sepolia but app pinned to Anvil" hang
 * where reads hit one chain and `writeContractAsync` silently targets another.
 */
export function usePinnedChainId(): SupportedDeployedChainId {
  const wallet = useChainId();
  const env = Number(process.env.NEXT_PUBLIC_CHAIN_ID);
  return (env || wallet) as SupportedDeployedChainId;
}

export function useContractClient() {
  const chainId = usePinnedChainId();
  return usePublicClient({ chainId });
}

/**
 * Drop-in replacement for `useWriteContract` that auto-injects the pinned
 * `chainId` on every call. If the wallet is on a different chain, wagmi will
 * surface `ChainMismatchError` (or trigger a wallet chain-switch) instead of
 * silently broadcasting on the wrong network.
 */
export function usePinnedWriteContract() {
  const chainId = usePinnedChainId();
  const wagmi = useWriteContract();
  const wagmiWrite = wagmi.writeContractAsync;
  const writeContractAsync = useCallback(
    (args: Parameters<typeof wagmiWrite>[0]) => wagmiWrite({ ...args, chainId } as typeof args),
    [wagmiWrite, chainId],
  ) as typeof wagmi.writeContractAsync;
  return { ...wagmi, writeContractAsync, chainId };
}

/** Stable empty ABI for `useReadContract`/`useReadContracts` while a contract
 *  lookup is pending. Wagmi requires an `abi` value even when `enabled: false`. */
export const EMPTY_ABI: Abi = [];

export interface WriteTxState {
  hash: `0x${string}` | undefined;
  isPending: boolean;
  isConfirming: boolean;
  isSuccess: boolean;
  error: Error | null;
}

export interface RunWriteTxArgs {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** Override the human label baked into thrown errors. Defaults to `functionName`. */
  label?: string;
}

/** Shared state machine for "send a write, wait for receipt, expose flags".
 *  Replaces the ~30-line copy-pasted pattern in settle/claim/cashout/etc.
 *  Returns `true` on success, `false` on revert or thrown error (error is set
 *  on `state.error`). Caller is responsible for guarding pre-conditions
 *  (contract loaded, user connected) before calling `run`. */
export function useWriteTx(): WriteTxState & { run: (args: RunWriteTxArgs) => Promise<boolean>; reset: () => void } {
  const publicClient = useContractClient();
  const { writeContractAsync } = usePinnedWriteContract();
  const [hash, setHash] = useState<`0x${string}` | undefined>(undefined);
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async ({ address, abi, functionName, args, label }: RunWriteTxArgs): Promise<boolean> => {
      if (!publicClient) return false;
      setIsPending(true);
      setIsConfirming(false);
      setIsSuccess(false);
      setError(null);
      setHash(undefined);
      try {
        const txHash = await writeContractAsync({
          address,
          abi,
          functionName,
          args: args as never,
          dataSuffix: BUILDER_SUFFIX,
        });
        setHash(txHash);
        setIsPending(false);
        setIsConfirming(true);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status === "reverted") {
          throw new Error(`${label ?? functionName} reverted on-chain`);
        }
        setIsConfirming(false);
        setIsSuccess(true);
        return true;
      } catch (err) {
        console.error(`${label ?? functionName} failed:`, err);
        setError(err instanceof Error ? err : new Error(String(err)));
        return false;
      } finally {
        setIsPending(false);
        setIsConfirming(false);
      }
    },
    [publicClient, writeContractAsync],
  );

  const reset = useCallback(() => {
    setIsSuccess(false);
    setError(null);
    setHash(undefined);
  }, []);

  return { hash, isPending, isConfirming, isSuccess, error, run, reset };
}
