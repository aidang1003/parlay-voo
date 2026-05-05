/**
 * Onboarding ETH drip. Sends a small ETH amount to a freshly-connected wallet
 * so the user has gas for their first txs. Server-relayed because the user
 * has no gas to call a faucet contract themselves (chicken-and-egg).
 *
 * Body: { address: 0x... }
 * Returns: { txHash } on success, { error } on failure.
 *
 * Relayer key: ANVIL_ACCOUNT_0 on local, HOT_SIGNER_PRIVATE_KEY otherwise.
 */
import { NextResponse } from "next/server";
import { type Chain, type Hex, createPublicClient, createWalletClient, http, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";
import {
  ANVIL_ACCOUNT_0_KEY,
  BASE_SEPOLIA_CHAIN_ID,
  LOCAL_CHAIN_ID,
  type SupportedChainId,
  getRpcUrl,
} from "~~/utils/parlay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Anvil's base fee climbs much higher than Base Sepolia's during a session,
// so a single 0.005 ETH drip runs out after a couple of txs locally. The
// "sufficient" threshold tracks the drip size so anvil users can top up
// before they run dry, instead of being told their wallet "already has gas".
const DRIP_AMOUNT: Record<typeof LOCAL_CHAIN_ID | typeof BASE_SEPOLIA_CHAIN_ID, bigint> = {
  [LOCAL_CHAIN_ID]: parseEther("0.05"),
  [BASE_SEPOLIA_CHAIN_ID]: parseEther("0.005"),
};
const SUFFICIENT_BALANCE: Record<typeof LOCAL_CHAIN_ID | typeof BASE_SEPOLIA_CHAIN_ID, bigint> = {
  [LOCAL_CHAIN_ID]: parseEther("0.05"),
  [BASE_SEPOLIA_CHAIN_ID]: parseEther("0.001"),
};
const COOLDOWN_MS = 60_000;

const lastClaim = new Map<string, number>();

export async function POST(req: Request) {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID) as SupportedChainId;
  if (chainId !== LOCAL_CHAIN_ID && chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return NextResponse.json({ error: "Not available on this chain" }, { status: 404 });
  }

  let body: { address?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const recipient = body.address;
  if (typeof recipient !== "string" || !isAddress(recipient)) {
    return NextResponse.json({ error: "valid address required" }, { status: 400 });
  }

  const key = recipient.toLowerCase();
  const now = Date.now();
  const last = lastClaim.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) {
    return NextResponse.json({ error: "Try again in a moment" }, { status: 429 });
  }

  const pk = (chainId === LOCAL_CHAIN_ID ? ANVIL_ACCOUNT_0_KEY : process.env.HOT_SIGNER_PRIVATE_KEY) as Hex | undefined;
  if (!pk) {
    return NextResponse.json({ error: "HOT_SIGNER_PRIVATE_KEY not set" }, { status: 500 });
  }

  const chain: Chain = chainId === LOCAL_CHAIN_ID ? foundry : baseSepolia;
  const rpcUrl = process.env.RPC_URL ?? getRpcUrl(chainId);
  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

  try {
    const balance = await publicClient.getBalance({ address: recipient });
    if (balance >= SUFFICIENT_BALANCE[chainId]) {
      return NextResponse.json({ ok: false, error: "Wallet already has gas" }, { status: 400 });
    }

    const hash = await walletClient.sendTransaction({ to: recipient, value: DRIP_AMOUNT[chainId], chain, account });
    await publicClient.waitForTransactionReceipt({ hash });
    lastClaim.set(key, now);
    return NextResponse.json({ ok: true, txHash: hash });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
