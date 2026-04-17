"use client";

import { useChainId, usePublicClient } from "wagmi";
import type { Abi } from "viem";
import type { SupportedDeployedChainId } from "../../contracts/deployedContracts";

/**
 * Resolves the chain this app reads from: `NEXT_PUBLIC_CHAIN_ID` if set
 * (production/local pin), else the wallet's active chain. Pinning prevents
 * "returned no data" errors when the wallet is on a chain the app is not
 * configured for.
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

/** Stable empty ABI for `useReadContract`/`useReadContracts` while a contract
 *  lookup is pending. Wagmi requires an `abi` value even when `enabled: false`. */
export const EMPTY_ABI: Abi = [];
