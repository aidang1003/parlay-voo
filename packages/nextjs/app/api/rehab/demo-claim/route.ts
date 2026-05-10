/**
 * Demo rehab claim. Mints MockUSDC equivalent to the credit the chain would
 * issue from `claimRehab` — i.e. `claimable * projectedAprBps / BPS` — to
 * the caller, then flips `blnrehabclaimed=true` on every Lost
 * tbticketdeviation row that contributed to the claimable so they stop
 * counting.
 *
 * Mirrors the existing demo-claim/route.ts pattern: server-side MockUSDC
 * mint via the hot signer key, no on-chain ParlayEngine / HouseVault state
 * mutation. When the chain later resolves the same tickets as real Losses,
 * the chain's own rehabClaimable mapping accrues independently — the user
 * can claim against both. Acceptable on testnet (MockUSDC is free).
 */
import { NextResponse } from "next/server";
import { type Abi, type Chain, type Hex, createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";
import { getDemoRehabClaimable, markDemoRehabClaimed } from "~~/lib/db/client";
import {
  ANVIL_ACCOUNT_0_KEY,
  BASE_SEPOLIA_CHAIN_ID,
  LOCAL_CHAIN_ID,
  type SupportedChainId,
  getRpcUrl,
} from "~~/utils/parlay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MOCK_USDC_ABI = parseAbi(["function mint(address to, uint256 amount)"]);
const HOUSE_VAULT_APR_ABI = parseAbi(["function projectedAprBps() view returns (uint256)"]);
const MAX_MINT = 10_000_000n * 1_000_000n; // matches MockUSDC.MAX_MINT
const BPS = 10_000n;
const FALLBACK_APR_BPS = 600n; // 6% — matches HouseVault default if the read fails

export async function POST(req: Request) {
  let body: { wallet?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const wallet = typeof body.wallet === "string" ? body.wallet.toLowerCase() : "";
  if (!ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: "wallet address required" }, { status: 400 });
  }

  const claimable = await getDemoRehabClaimable(wallet);
  if (claimable <= 0n) {
    return NextResponse.json({ error: "nothing to claim" }, { status: 422 });
  }

  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? String(BASE_SEPOLIA_CHAIN_ID)) as SupportedChainId;
  if (chainId !== LOCAL_CHAIN_ID && chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return NextResponse.json({ error: "demo claim not available on this chain" }, { status: 404 });
  }

  const contracts = (deployedContracts[chainId as keyof typeof deployedContracts] ??
    Object.values(deployedContracts)[0]) as Record<string, { address: `0x${string}`; abi: Abi }>;
  const usdc = contracts.MockUSDC;
  const vault = contracts.HouseVault;
  if (!usdc) {
    return NextResponse.json({ error: "MockUSDC not deployed on this chain" }, { status: 500 });
  }

  const pk = (chainId === LOCAL_CHAIN_ID ? ANVIL_ACCOUNT_0_KEY : process.env.HOT_SIGNER_PRIVATE_KEY) as Hex | undefined;
  if (!pk) {
    return NextResponse.json({ error: "HOT_SIGNER_PRIVATE_KEY not set" }, { status: 500 });
  }

  try {
    const chain: Chain = chainId === LOCAL_CHAIN_ID ? foundry : baseSepolia;
    const rpcUrl = process.env.RPC_URL ?? getRpcUrl(chainId);
    const account = privateKeyToAccount(pk);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

    // Match what the chain rehab claim would issue: credit = claimable * apr / BPS.
    let aprBps = FALLBACK_APR_BPS;
    if (vault) {
      try {
        aprBps = (await publicClient.readContract({
          address: vault.address,
          abi: HOUSE_VAULT_APR_ABI,
          functionName: "projectedAprBps",
        })) as bigint;
      } catch {
        // Stick with FALLBACK_APR_BPS
      }
    }
    const credit = (claimable * aprBps) / BPS;
    if (credit <= 0n) {
      return NextResponse.json({ error: "credit rounds to zero" }, { status: 422 });
    }
    if (credit > MAX_MINT) {
      return NextResponse.json({ error: "credit exceeds MockUSDC.MAX_MINT" }, { status: 500 });
    }

    const hash = await walletClient.writeContract({
      address: usdc.address,
      abi: MOCK_USDC_ABI,
      functionName: "mint",
      args: [wallet as `0x${string}`, credit],
      chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const { updated, total } = await markDemoRehabClaimed(wallet);
    return NextResponse.json({
      ok: true,
      txHash: hash,
      mintedCredit: credit.toString(),
      claimableConsumed: total.toString(),
      rowsUpdated: updated,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
