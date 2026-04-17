/**
 * Shared env-loading utilities for agent scripts.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { ANVIL_ACCOUNT_0_KEY } from "../../packages/shared/src/chains";

export { ANVIL_ACCOUNT_0_KEY };

/** Anvil account #1 — used by scripts that need a second funded EOA distinct
 *  from the deployer. Not needed in shared since only scripts use it. */
export const ANVIL_ACCOUNT_1_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

/**
 * Resolve the key an agent/user script should sign with.
 * Reads `DEPLOYER_PRIVATE_KEY` and falls back to the supplied anvil account.
 * Callers should run `requireExplicitKeyForRemoteRpc(rpcUrl)` first so the
 * anvil fallback can only reach remote RPCs by explicit user choice.
 */
export function resolveAgentKey(fallback: string = ANVIL_ACCOUNT_0_KEY): `0x${string}` {
  return (process.env.DEPLOYER_PRIVATE_KEY ?? fallback) as `0x${string}`;
}

/**
 * Parse packages/nextjs/.env.local into a key-value record.
 * Returns empty record if file is missing or unreadable.
 */
export function loadEnvLocal(): Record<string, string> {
  // Walk up from scripts/ to repo root, then into packages/nextjs
  const envPath = resolve(__dirname, "../../packages/nextjs/.env.local");
  try {
    const content = readFileSync(envPath, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
    return vars;
  } catch {
    return {};
  }
}

/**
 * Guard: when RPC_URL points to a non-local network, DEPLOYER_PRIVATE_KEY must
 * be explicitly provided. Prevents accidentally broadcasting with anvil keys
 * on a real chain.
 */
export function requireExplicitKeyForRemoteRpc(rpcUrl: string): void {
  const isLocal =
    rpcUrl.includes("127.0.0.1") ||
    rpcUrl.includes("localhost") ||
    rpcUrl.includes("0.0.0.0");

  if (!isLocal && !process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error(
      `RPC_URL points to a remote network (${rpcUrl}) but DEPLOYER_PRIVATE_KEY is not set. ` +
        "Refusing to use default anvil key on a non-local chain. " +
        "Set DEPLOYER_PRIVATE_KEY explicitly.",
    );
  }
}

/**
 * Parse a numeric env var with NaN guard and fallback.
 */
export function safeParseNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[env] ${name}="${raw}" is not a valid number, using default ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * Safe BigInt -> Number conversion. Throws if the value exceeds
 * Number.MAX_SAFE_INTEGER.
 */
export function safeBigIntToNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds Number.MAX_SAFE_INTEGER: ${value}`);
  }
  return Number(value);
}
