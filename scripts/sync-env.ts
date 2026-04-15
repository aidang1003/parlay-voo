#!/usr/bin/env tsx
/**
 * Reads deployed contract addresses from forge broadcast output and writes
 * them to packages/nextjs/.env.local. Replaces the old sync-env.sh.
 *
 * Usage:
 *   tsx scripts/sync-env.ts           # Anvil (chain 31337)
 *   tsx scripts/sync-env.ts sepolia   # Base Sepolia (chain 84532)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const network = process.argv[2] ?? "local";
const chainId = network === "sepolia" ? 84532 : 31337;

const broadcastPath = resolve(
  ROOT,
  `packages/foundry/broadcast/Deploy.s.sol/${chainId}/run-latest.json`,
);
const envFile = resolve(ROOT, "packages/nextjs/.env.local");

if (!existsSync(broadcastPath)) {
  console.error(`No broadcast file at ${broadcastPath}`);
  console.error(
    network === "sepolia"
      ? "Run 'pnpm deploy:sepolia' first."
      : "Run 'pnpm deploy:local' first.",
  );
  process.exit(1);
}

type Tx = { transactionType?: string; contractName?: string; contractAddress?: string };
const broadcast = JSON.parse(readFileSync(broadcastPath, "utf8")) as { transactions: Tx[] };

const firstCreate = (name: string): string =>
  broadcast.transactions.find(
    (t) => t.transactionType === "CREATE" && t.contractName === name,
  )?.contractAddress ?? "";

const usdc = process.env.USDC_ADDRESS || firstCreate("MockUSDC");
if (!usdc) {
  console.error(
    "No USDC_ADDRESS env var and no MockUSDC in broadcast. Set USDC_ADDRESS for Sepolia.",
  );
  process.exit(1);
}

const addresses = {
  NEXT_PUBLIC_CHAIN_ID: String(chainId),
  NEXT_PUBLIC_HOUSE_VAULT_ADDRESS: firstCreate("HouseVault"),
  NEXT_PUBLIC_PARLAY_ENGINE_ADDRESS: firstCreate("ParlayEngine"),
  NEXT_PUBLIC_LEG_REGISTRY_ADDRESS: firstCreate("LegRegistry"),
  NEXT_PUBLIC_USDC_ADDRESS: usdc,
  NEXT_PUBLIC_LOCK_VAULT_ADDRESS: firstCreate("LockVault"),
  NEXT_PUBLIC_ADMIN_ORACLE_ADDRESS: firstCreate("AdminOracleAdapter"),
  ADMIN_ORACLE_ADDRESS: firstCreate("AdminOracleAdapter"),
};

// Secrets flow from the single root .env. Falling back to the existing
// .env.local lets manually-edited values in the generated file survive a
// redeploy when root .env has not yet been populated (common in fresh clones).
const FORWARD = [
  "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
  "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL",
  "DATABASE_URL",
  "CRON_SECRET",
  "DEPLOYER_PRIVATE_KEY",
  "QUOTE_SIGNER_PRIVATE_KEY",
];

const readEnv = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
};

const rootEnv = readEnv(resolve(ROOT, ".env"));
const existingLocal = readEnv(envFile);
const forwarded: Record<string, string> = {};
for (const key of FORWARD) forwarded[key] = rootEnv[key] ?? existingLocal[key] ?? "";

const lines = [
  ...Object.entries(addresses).map(([k, v]) => `${k}=${v}`),
  ...Object.entries(forwarded).map(([k, v]) => `${k}=${v}`),
];
writeFileSync(envFile, lines.join("\n") + "\n");

console.log(`Updated ${envFile} (chain ${chainId}):`);
for (const [k, v] of Object.entries(addresses)) {
  if (k.endsWith("_ADDRESS")) console.log(`  ${k.padEnd(40)} ${v}`);
}
