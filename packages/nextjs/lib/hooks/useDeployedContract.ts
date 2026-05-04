"use client";

import type { ContractName, SupportedDeployedChainId } from "../../contracts/deployedContractTypes";
import deployedContracts from "../../contracts/deployedContracts";
import { usePinnedChainId } from "./_internal";
import type { Abi } from "viem";

export type DeployedContract = { address: `0x${string}`; abi: Abi };

/**
 * Returns `{ address, abi }` for a contract on the given chain. Defaults to
 * `usePinnedChainId()` (NEXT_PUBLIC_CHAIN_ID → wallet chain) so reads and
 * writes target the same network. Returns `undefined` if the contract isn't
 * deployed on that chain — callers treat that as "not ready".
 *
 * The friendly contract names (`"HouseVault"`, `"ParlayEngine"`, ...) come
 * from `scripts/generate-deployed-contracts.ts`. Keep them stable.
 */
export function useDeployedContract<C extends SupportedDeployedChainId, N extends ContractName<C>>(
  contractName: N,
  options?: { chainId?: C },
): DeployedContract | undefined {
  const pinned = usePinnedChainId();
  const chainId = (options?.chainId ?? pinned) as SupportedDeployedChainId;
  return resolveDeployed(chainId, contractName as string);
}

function resolveDeployed(chainId: SupportedDeployedChainId, contractName: string): DeployedContract | undefined {
  const chainEntry = deployedContracts[chainId] as Record<string, { address: `0x${string}`; abi: Abi }> | undefined;
  if (!chainEntry) return undefined;
  const c = chainEntry[contractName];
  if (!c) return undefined;
  return c;
}
