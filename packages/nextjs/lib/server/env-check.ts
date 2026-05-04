// Boot-time validator for cross-package env propagation. Catches the failure
// mode where the on-chain `trustedQuoteSigner` and the runtime quote-signing
// key disagree — which silently reverts every ticket purchase. Mirrors the
// signer-key precedence ladder from app/api/quote-sign/route.ts so the check
// matches the runtime behaviour exactly.
//
// Hooked from instrumentation.ts; runs once per server boot. Fire-and-forget
// so the RPC call doesn't block startup latency.
import { type Hex, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import deployedContracts from "~~/contracts/deployedContracts";
import { ANVIL_ACCOUNT_0_KEY, LOCAL_CHAIN_ID, type SupportedChainId, getRpcUrl } from "~~/utils/parlay";

const TRUSTED_QUOTE_SIGNER_ABI = [
  {
    inputs: [],
    name: "trustedQuoteSigner",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

function frame(lines: string[]): string {
  const width = Math.max(...lines.map(l => l.length));
  const bar = "─".repeat(width + 2);
  const body = lines.map(l => "│ " + l.padEnd(width) + " │").join("\n");
  return `\n┌${bar}┐\n${body}\n└${bar}┘\n`;
}

export async function checkEnv(): Promise<void> {
  const rawChainId = process.env.NEXT_PUBLIC_CHAIN_ID;
  if (!rawChainId) {
    console.warn(
      frame([
        "⚠  ENV CHECK: NEXT_PUBLIC_CHAIN_ID is not set.",
        "Chain selection, quote signing, and RPC routing will misbehave.",
        "Fix: edit /.env at repo root, then `pnpm setup:env`.",
      ]),
    );
    return;
  }
  const chainId = Number(rawChainId) as SupportedChainId;

  const signerKey = (process.env.HOT_SIGNER_PRIVATE_KEY ||
    process.env.WARM_DEPLOYER_PRIVATE_KEY ||
    (chainId === LOCAL_CHAIN_ID ? ANVIL_ACCOUNT_0_KEY : undefined)) as Hex | undefined;

  if (!signerKey) {
    console.warn(
      frame([
        "⚠  ENV CHECK: no quote-signer private key in env.",
        "HOT_SIGNER_PRIVATE_KEY (preferred) or WARM_DEPLOYER_PRIVATE_KEY required.",
        "Quote signing will fail; ticket purchases will revert.",
        "Fix: edit /.env at repo root, then `pnpm setup:env`.",
      ]),
    );
    return;
  }

  let expectedSigner: string;
  try {
    expectedSigner = privateKeyToAccount(signerKey).address;
  } catch (e) {
    console.warn(
      frame(["⚠  ENV CHECK: signer key is malformed.", `Error: ${e instanceof Error ? e.message : String(e)}`]),
    );
    return;
  }

  const chainContracts = deployedContracts[chainId as keyof typeof deployedContracts] as
    | Record<string, { address: string }>
    | undefined;
  const engine = chainContracts?.ParlayEngine;
  if (!engine?.address) {
    // No deployment for this chain yet — normal on a fresh anvil before `pnpm deploy`.
    return;
  }

  let onchainSigner: string;
  try {
    const client = createPublicClient({ transport: http(getRpcUrl(chainId)) });
    onchainSigner = await client.readContract({
      address: engine.address as `0x${string}`,
      abi: TRUSTED_QUOTE_SIGNER_ABI,
      functionName: "trustedQuoteSigner",
    });
  } catch (e) {
    // RPC unreachable (anvil not running, mainnet API key missing, etc.) — soft notice.
    console.warn(
      `[env-check] could not read trustedQuoteSigner from chain ${chainId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return;
  }

  if (onchainSigner.toLowerCase() === expectedSigner.toLowerCase()) {
    console.log(`✓ env-check: HOT_SIGNER (${expectedSigner}) matches onchain trustedQuoteSigner on chain ${chainId}`);
    return;
  }

  console.warn(
    frame([
      "⚠  ENV CHECK: signer mismatch — TICKETS WILL REVERT",
      "",
      `expected (env):   ${expectedSigner}`,
      `actual (onchain): ${onchainSigner}`,
      `chain:            ${chainId}`,
      `engine:           ${engine.address}`,
      "",
      "Fix one of:",
      "  1. `pnpm setup:env && pnpm redeploy:local` — rewrite onchain to match env",
      "  2. Update HOT_SIGNER_PRIVATE_KEY in /.env to the keypair already onchain",
    ]),
  );
}
