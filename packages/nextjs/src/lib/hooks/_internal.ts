"use client";

import { useCallback } from "react";
import { useChainId, usePublicClient, useWriteContract } from "wagmi";
import type { Abi } from "viem";
import { CHAINS, type SupportedChainId } from "@parlaycity/shared";
import type { SupportedDeployedChainId } from "../../contracts/deployedContracts";

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

/**
 * Throws a readable error when a `useDeployedContract` lookup returned
 * `undefined` (contract missing on the pinned chain). Mirrors the guard
 * pattern in `useMintTestUSDC`.
 */
export function assertDeployed<T extends { address: `0x${string}`; abi: Abi }>(
  contract: T | undefined,
  label: string,
  chainId: number,
): T {
  if (!contract) {
    const name = CHAINS[chainId as SupportedChainId]?.name ?? `chain ${chainId}`;
    throw new Error(`${label} is not deployed on ${name}`);
  }
  return contract;
}

/** Stable empty ABI for `useReadContract`/`useReadContracts` while a contract
 *  lookup is pending. Wagmi requires an `abi` value even when `enabled: false`. */
export const EMPTY_ABI: Abi = [];
