"use client";

import type {Abi} from "viem";
import deployedContracts, {
  type SupportedDeployedChainId,
  type ContractName,
} from "../../contracts/deployedContracts";
import {LOCAL_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID} from "@parlaycity/shared";
import {usePinnedChainId} from "./_internal";

const availableChainIds = Object.keys(deployedContracts).map(Number) as SupportedDeployedChainId[];
const FALLBACK_CHAIN_ID: SupportedDeployedChainId = availableChainIds[0];

export type DeployedContract = {address: `0x${string}`; abi: Abi};

/**
 * Returns `{ address, abi }` for a contract on the given chain. Defaults to
 * `usePinnedChainId()` (NEXT_PUBLIC_CHAIN_ID → wallet chain) so reads and
 * writes target the same network. Returns `undefined` if the contract isn't
 * deployed on that chain — callers treat that as "not ready" or throw via
 * `assertDeployed` from `lib/hooks/_internal`.
 *
 * The friendly contract names (`"HouseVault"`, `"ParlayEngine"`, ...) come
 * from `scripts/generate-deployed-contracts.ts`. Keep them stable.
 */
export function useDeployedContract<
  C extends SupportedDeployedChainId,
  N extends ContractName<C>,
>(
  contractName: N,
  options?: {chainId?: C},
): DeployedContract | undefined {
  const pinned = usePinnedChainId();
  const chainId = (options?.chainId ?? pinned) as SupportedDeployedChainId;
  return resolveDeployed(chainId, contractName as string);
}

/**
 * Non-hook lookup, for module-scope or non-React contexts. Falls back to the
 * default chain if the supplied id isn't deployed.
 */
export function getDeployedContract(
  chainId: number,
  contractName: string,
): (DeployedContract & {chainId: SupportedDeployedChainId}) | undefined {
  const resolved = resolveDeployed(chainId as SupportedDeployedChainId, contractName);
  if (resolved) {
    return {...resolved, chainId: chainId as SupportedDeployedChainId};
  }
  const fallback = resolveDeployed(FALLBACK_CHAIN_ID, contractName);
  if (fallback) {
    return {...fallback, chainId: FALLBACK_CHAIN_ID};
  }
  return undefined;
}

function resolveDeployed(
  chainId: SupportedDeployedChainId,
  contractName: string,
): DeployedContract | undefined {
  const chainEntry = deployedContracts[chainId] as
    | Record<string, {address: `0x${string}`; abi: Abi}>
    | undefined;
  if (!chainEntry) return undefined;
  const c = chainEntry[contractName];
  if (!c) return undefined;
  return c;
}

/** Re-export chain IDs for convenience at call sites. */
export {LOCAL_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID};
