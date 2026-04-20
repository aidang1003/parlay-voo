/**
 * Testnet-only leg resolver for the F-6 debug page. Signs
 * AdminOracleAdapter.resolve() server-side with DEPLOYER_PRIVATE_KEY so no
 * external binaries (forge / pnpm) are needed on Vercel.
 *
 * Body: { legId: string, status: 1 | 2 | 3 } (1=Won/YES, 2=Lost/NO, 3=Voided).
 */

import { NextResponse } from "next/server";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry, baseSepolia } from "viem/chains";
import {
  ANVIL_ACCOUNT_0_KEY,
  BASE_SEPOLIA_CHAIN_ID,
  LOCAL_CHAIN_ID,
  getRpcUrl,
  type SupportedChainId,
} from "@parlayvoo/shared";
import deployedContracts from "@/contracts/deployedContracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADMIN_ORACLE_ABI = parseAbi([
  "function resolve(uint256 legId, uint8 status, bytes32 outcome)",
  "function canResolve(uint256 legId) view returns (bool)",
]);

const YES_OUTCOME = ("0x" + "01".padStart(64, "0")) as Hex;
const NO_OUTCOME  = ("0x" + "02".padStart(64, "0")) as Hex;
const VOID_OUTCOME = ("0x" + "0".padStart(64, "0")) as Hex;

export async function POST(req: Request) {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID) as SupportedChainId;
  if (chainId !== LOCAL_CHAIN_ID && chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return NextResponse.json({ error: "Not available on this chain" }, { status: 404 });
  }

  let body: { legId?: unknown; status?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const legIdRaw = body.legId;
  const status = body.status;
  if (typeof legIdRaw !== "string" && typeof legIdRaw !== "number") {
    return NextResponse.json({ error: "legId required" }, { status: 400 });
  }
  if (status !== 1 && status !== 2 && status !== 3) {
    return NextResponse.json({ error: "status must be 1, 2, or 3" }, { status: 400 });
  }

  let legId: bigint;
  try {
    legId = BigInt(legIdRaw as string);
  } catch {
    return NextResponse.json({ error: "legId not parseable as bigint" }, { status: 400 });
  }

  const entry = (deployedContracts as Record<number, Record<string, { address: `0x${string}` }>>)[chainId];
  if (!entry?.AdminOracleAdapter?.address) {
    return NextResponse.json({ error: "AdminOracleAdapter not deployed on this chain" }, { status: 500 });
  }
  const oracleAddr = entry.AdminOracleAdapter.address;

  const pk = (process.env.DEPLOYER_PRIVATE_KEY
    ?? (chainId === LOCAL_CHAIN_ID ? ANVIL_ACCOUNT_0_KEY : undefined)) as Hex | undefined;
  if (!pk) {
    return NextResponse.json({ error: "DEPLOYER_PRIVATE_KEY not set" }, { status: 500 });
  }

  const chain: Chain = chainId === LOCAL_CHAIN_ID ? foundry : baseSepolia;
  const rpcUrl = process.env.RPC_URL ?? getRpcUrl(chainId);
  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

  const outcome = status === 1 ? YES_OUTCOME : status === 2 ? NO_OUTCOME : VOID_OUTCOME;

  try {
    const alreadyResolved = (await publicClient.readContract({
      address: oracleAddr,
      abi: ADMIN_ORACLE_ABI,
      functionName: "canResolve",
      args: [legId],
    })) as boolean;
    if (alreadyResolved) {
      return NextResponse.json({ ok: false, error: "leg already resolved" }, { status: 409 });
    }

    const hash = await walletClient.writeContract({
      address: oracleAddr,
      abi: ADMIN_ORACLE_ABI,
      functionName: "resolve",
      args: [legId, status, outcome],
      chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return NextResponse.json({ ok: true, txHash: hash });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
