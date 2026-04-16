"use client";

import {useChainId} from "wagmi";
import deployedContracts, {
  type SupportedDeployedChainId,
  type ContractName,
} from "../contracts/deployedContracts";
import {LOCAL_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID} from "@parlaycity/shared";

/**
 * Default chain to use when wagmi reports a chain we don't recognize (e.g. the
 * user is on mainnet without contracts deployed there). Pages that legitimately
 * need a fixed chain — e.g. the LP dashboard always pointing at Sepolia — pass
 * a `chainId` override.
 */
const FALLBACK_CHAIN_ID: SupportedDeployedChainId = BASE_SEPOLIA_CHAIN_ID;

/**
 * Returns `{ address, abi }` for a contract on the given chain (or the active
 * wagmi chain). Returns `undefined` if the contract is not deployed on that
 * chain — call sites should treat that as "not ready" rather than throw.
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
): {address: `0x${string}`; abi: unknown} | undefined {
  const wagmiChainId = useChainId();
  const chainId = (options?.chainId ?? wagmiChainId) as SupportedDeployedChainId;
  return resolveDeployed(chainId, contractName as string);
}

/**
 * Non-hook lookup, for module-scope or non-React contexts. Falls back to the
 * default chain if the supplied id isn't deployed.
 */
export function getDeployedContract(
  chainId: number,
  contractName: string,
):
  | {address: `0x${string}`; abi: unknown; chainId: SupportedDeployedChainId}
  | undefined {
  const resolved = resolveDeployed(chainId as SupportedDeployedChainId, contractName);
  if (resolved) {
    return {...resolved, chainId: chainId as SupportedDeployedChainId};
  }
  // Try fallback chain
  const fallback = resolveDeployed(FALLBACK_CHAIN_ID, contractName);
  if (fallback) {
    return {...fallback, chainId: FALLBACK_CHAIN_ID};
  }
  return undefined;
}

function resolveDeployed(
  chainId: SupportedDeployedChainId,
  contractName: string,
): {address: `0x${string}`; abi: unknown} | undefined {
  const chainEntry = deployedContracts[chainId] as
    | Record<string, {address: `0x${string}`; abi: unknown}>
    | undefined;
  if (!chainEntry) return undefined;
  const c = chainEntry[contractName];
  if (!c) return undefined;
  return c;
}

/** Re-export chain IDs for convenience at call sites. */
export {LOCAL_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID};
