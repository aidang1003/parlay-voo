#!/usr/bin/env tsx
/**
 * Walks forge broadcast JSON for every chainId that has a deploy on disk,
 * pairs each contract with its ABI from forge `out/`, and writes two
 * artifacts:
 *
 *   1. packages/nextjs/src/contracts/deployedContracts.ts
 *      — committed; consumed by `useDeployedContract` in the Next.js app
 *
 *   2. packages/foundry/deployments/<chainId>.json
 *      — committed; consumed by Solidity scripts via `vm.readFile`
 *        and by tsx scripts that need address lookup off-chain
 *
 * No env vars. No .env.local writes. The deployedContracts.ts file IS the
 * source of truth; broadcast/out/ are intermediate forge outputs we transform.
 *
 * Usage:
 *   tsx scripts/generate-deployed-contracts.ts
 *
 * Optional: pass a chainId to regenerate only that chain (other chains in the
 * existing deployedContracts.ts are preserved):
 *   tsx scripts/generate-deployed-contracts.ts 31337
 */
import {existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BROADCAST_DIR = resolve(ROOT, "packages/foundry/broadcast/Deploy.s.sol");
const FORGE_OUT_DIR = resolve(ROOT, "packages/foundry/out");
const TS_OUT = resolve(ROOT, "packages/nextjs/src/contracts/deployedContracts.ts");
const JSON_OUT_DIR = resolve(ROOT, "packages/foundry/deployments");

/** Contracts we actually want to expose. Keys are forge contract names; values
 *  are the friendly names used by the frontend hook. Keep the friendly names
 *  stable — call sites depend on them. */
const CONTRACT_NAMES: Record<string, string> = {
  MockUSDC: "MockUSDC",
  HouseVault: "HouseVault",
  ParlayEngine: "ParlayEngine",
  LegRegistry: "LegRegistry",
  LockVaultV2: "LockVaultV2",
  AdminOracleAdapter: "AdminOracleAdapter",
  UmaOracleAdapter: "UmaOracleAdapter",
  MockYieldAdapter: "MockYieldAdapter",
};

interface BroadcastTx {
  transactionType?: string;
  contractName?: string;
  contractAddress?: string;
}

interface BroadcastFile {
  transactions: BroadcastTx[];
}

interface ChainEntry {
  [contractName: string]: {
    address: `0x${string}`;
    abi: unknown[];
  };
}

function discoverChainIds(): number[] {
  if (!existsSync(BROADCAST_DIR)) return [];
  return readdirSync(BROADCAST_DIR, {withFileTypes: true})
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => Number(d.name))
    .sort((a, b) => a - b);
}

function readBroadcast(chainId: number): BroadcastFile | undefined {
  const path = resolve(BROADCAST_DIR, String(chainId), "run-latest.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as BroadcastFile;
}

function readAbi(forgeName: string): unknown[] | undefined {
  const path = resolve(FORGE_OUT_DIR, `${forgeName}.sol`, `${forgeName}.json`);
  if (!existsSync(path)) return undefined;
  const artifact = JSON.parse(readFileSync(path, "utf8")) as {abi?: unknown[]};
  return artifact.abi;
}

function buildChainEntry(broadcast: BroadcastFile): ChainEntry {
  const entry: ChainEntry = {};
  // Pick the LAST CREATE per contractName so re-deployments in the same broadcast win.
  const lastByName = new Map<string, string>();
  for (const tx of broadcast.transactions) {
    if (tx.transactionType !== "CREATE" || !tx.contractName || !tx.contractAddress) continue;
    if (!CONTRACT_NAMES[tx.contractName]) continue;
    lastByName.set(tx.contractName, tx.contractAddress);
  }
  for (const [forgeName, address] of lastByName) {
    const abi = readAbi(forgeName);
    if (!abi) {
      console.warn(`  ! ABI not found for ${forgeName}, skipping (run forge build first?)`);
      continue;
    }
    entry[CONTRACT_NAMES[forgeName]] = {address: address as `0x${string}`, abi};
  }
  return entry;
}

function loadExisting(): Record<number, ChainEntry> {
  // Re-import the previous file to preserve chains not being regenerated this run.
  // We parse it loosely rather than importing it (avoids requiring nextjs deps in tsx).
  if (!existsSync(TS_OUT)) return {};
  const src = readFileSync(TS_OUT, "utf8");
  const match = src.match(/const deployedContracts = ({[\s\S]*?}) as const;/);
  if (!match) return {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`return ${match[1]};`)() as Record<number, ChainEntry>;
  } catch {
    return {};
  }
}

function emitTs(all: Record<number, ChainEntry>): string {
  const chainIds = Object.keys(all)
    .map(Number)
    .sort((a, b) => a - b);
  const body = chainIds
    .map((id) => {
      const entry = all[id];
      const contracts = Object.keys(entry)
        .sort()
        .map((name) => {
          const c = entry[name];
          return `    ${name}: {\n      address: "${c.address}",\n      abi: ${JSON.stringify(c.abi)},\n    },`;
        })
        .join("\n");
      return `  ${id}: {\n${contracts}\n  },`;
    })
    .join("\n");

  return `/**
 * AUTO-GENERATED by scripts/generate-deployed-contracts.ts. Do not edit by hand.
 *
 * Source: packages/foundry/broadcast/Deploy.s.sol/<chainId>/run-latest.json
 *         packages/foundry/out/<Contract>.sol/<Contract>.json
 *
 * Regenerate: pnpm deploy:local | pnpm deploy:sepolia (chained automatically)
 *             or run \`tsx scripts/generate-deployed-contracts.ts\` directly.
 */
const deployedContracts = {
${body}
} as const;

export default deployedContracts;
export type DeployedContracts = typeof deployedContracts;
export type SupportedChainId = keyof DeployedContracts;
export type SupportedDeployedChainId = SupportedChainId;
// Union of all contract names across all chains (mapped-type so default C
// does not collapse to intersection). Passing a specific C narrows to that chain.
export type ContractName<C extends SupportedChainId = SupportedChainId> =
  { [K in C]: keyof DeployedContracts[K] }[C];
`;
}

function emitJson(entry: ChainEntry): string {
  // Slim per-chain JSON: addresses only, no ABIs (Solidity scripts only need addresses).
  const slim: Record<string, string> = {};
  for (const [name, c] of Object.entries(entry)) slim[name] = c.address;
  return JSON.stringify(slim, null, 2) + "\n";
}

function main() {
  const onlyChainArg = process.argv[2];
  const onlyChain = onlyChainArg ? Number(onlyChainArg) : undefined;
  if (onlyChainArg && Number.isNaN(onlyChain)) {
    console.error(`Bad chainId: ${onlyChainArg}`);
    process.exit(1);
  }

  const discovered = discoverChainIds();
  if (discovered.length === 0) {
    console.error(`No broadcasts found under ${BROADCAST_DIR}.`);
    console.error(`Run \`pnpm deploy:local\` or \`pnpm deploy:sepolia\` first.`);
    process.exit(1);
  }

  const merged = loadExisting();
  const targetChains = onlyChain ? [onlyChain] : discovered;
  const updatedChains: number[] = [];

  for (const chainId of targetChains) {
    const broadcast = readBroadcast(chainId);
    if (!broadcast) {
      console.warn(`  ! no broadcast for chain ${chainId}, skipping`);
      continue;
    }
    const entry = buildChainEntry(broadcast);
    if (Object.keys(entry).length === 0) {
      console.warn(`  ! no recognized contracts in broadcast for chain ${chainId}`);
      continue;
    }
    merged[chainId] = entry;
    updatedChains.push(chainId);
    console.log(`  ✓ chain ${chainId}: ${Object.keys(entry).length} contracts`);
  }

  if (Object.keys(merged).length === 0) {
    console.error("Nothing to write.");
    process.exit(1);
  }

  mkdirSync(dirname(TS_OUT), {recursive: true});
  writeFileSync(TS_OUT, emitTs(merged));
  console.log(`Wrote ${TS_OUT}`);

  mkdirSync(JSON_OUT_DIR, {recursive: true});
  for (const chainId of updatedChains) {
    const path = resolve(JSON_OUT_DIR, `${chainId}.json`);
    writeFileSync(path, emitJson(merged[chainId]));
    console.log(`Wrote ${path}`);
  }
}

main();
