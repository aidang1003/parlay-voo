import { NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, isAddress, type Hex } from "viem";
import deployedContracts from "@/contracts/deployedContracts";
import { buildLegs, LegBuildError, type LegInput } from "@/lib/quote/build-legs";
import {
  ANVIL_ACCOUNT_0_KEY,
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  LOCAL_CHAIN_ID,
  type SupportedChainId,
} from "@parlayvoo/shared";

/**
 * POST /api/quote-sign
 *
 * Produces an EIP-712 signed Quote that ParlayEngine.buyTicketSigned() will
 * accept. The server is the trusted price oracle: for polymarket legs it
 * refetches the CLOB mid at sign time and uses that PPM (falling back to the
 * DB-stored PPM if the refetch fails). For seed legs it uses the DB PPM.
 *
 * Request body:
 *   {
 *     buyer:   "0x..."                   (required)
 *     stake:   string decimal USDC wei   (required, 6 decimals — passed through)
 *     legs: [{ sourceRef: string, side: "yes" | "no" }]
 *   }
 */

interface QuoteBody {
  buyer: string;
  stake: string;
  legs: LegInput[];
}

export async function POST(req: Request) {
  let body: QuoteBody;
  try {
    body = (await req.json()) as QuoteBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body?.buyer || !isAddress(body.buyer)) {
    return NextResponse.json({ error: "invalid buyer" }, { status: 400 });
  }
  if (!Array.isArray(body.legs) || body.legs.length < 2 || body.legs.length > 5) {
    return NextResponse.json({ error: "legs must be 2..5" }, { status: 400 });
  }
  const chainId = Number(
    process.env.NEXT_PUBLIC_CHAIN_ID || String(LOCAL_CHAIN_ID),
  ) as SupportedChainId;
  const signerKey = (process.env.QUOTE_SIGNER_PRIVATE_KEY
    || process.env.DEPLOYER_PRIVATE_KEY
    || (chainId === LOCAL_CHAIN_ID ? ANVIL_ACCOUNT_0_KEY : undefined)) as Hex | undefined;
  const chainContracts =
    (deployedContracts[chainId as keyof typeof deployedContracts] ??
      Object.values(deployedContracts)[0]) as Record<string, {address: string}>;
  const engineAddr = chainContracts.ParlayEngine?.address;

  const oracleMode = process.env.NEXT_PUBLIC_ORACLE_MODE ?? "admin";
  const useUma =
    chainId === BASE_MAINNET_CHAIN_ID || (chainId === BASE_SEPOLIA_CHAIN_ID && oracleMode === "uma");
  const oracleAddr = useUma
    ? chainContracts.UmaOracleAdapter?.address
    : chainContracts.AdminOracleAdapter?.address;

  if (!signerKey) {
    return NextResponse.json(
      { error: "neither QUOTE_SIGNER_PRIVATE_KEY nor DEPLOYER_PRIVATE_KEY is set" },
      { status: 500 },
    );
  }
  if (!engineAddr || !oracleAddr) {
    return NextResponse.json(
      { error: `engine/oracle address not configured (mode=${useUma ? "uma" : "admin"})` },
      { status: 500 },
    );
  }

  let built;
  try {
    built = await buildLegs(body.legs);
  } catch (e) {
    if (e instanceof LegBuildError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const signedLegs = built.map((leg) => ({
    sourceRef: leg.sourceRef,
    outcome: leg.outcome,
    probabilityPPM: BigInt(leg.probabilityPPM),
    cutoffTime: BigInt(leg.cutoffTime),
    earliestResolve: BigInt(leg.earliestResolve),
    oracleAdapter: getAddress(oracleAddr),
  }));

  const nonce = BigInt("0x" + crypto.randomUUID().replace(/-/g, "")) & ((1n << 128n) - 1n);
  // 10 min: the buy flow is approve-then-buy, so a tight TTL (e.g. 60s) expires
  // during the approve's block confirmation on testnet and the engine reverts
  // "quote expired". Nonce still bounds replay, so widening TTL is safe.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  const quote = {
    buyer: getAddress(body.buyer),
    stake: BigInt(body.stake),
    legs: signedLegs,
    deadline,
    nonce,
  };

  const account = privateKeyToAccount(signerKey);
  const signature = await account.signTypedData({
    domain: {
      name: "ParlayVoo",
      version: "1",
      chainId,
      verifyingContract: getAddress(engineAddr) as `0x${string}`,
    },
    types: {
      SourceLeg: [
        { name: "sourceRef", type: "string" },
        { name: "outcome", type: "bytes32" },
        { name: "probabilityPPM", type: "uint256" },
        { name: "cutoffTime", type: "uint256" },
        { name: "earliestResolve", type: "uint256" },
        { name: "oracleAdapter", type: "address" },
      ],
      Quote: [
        { name: "buyer", type: "address" },
        { name: "stake", type: "uint256" },
        { name: "legs", type: "SourceLeg[]" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "Quote",
    message: quote,
  });

  return NextResponse.json({
    quote: {
      buyer: quote.buyer,
      stake: quote.stake.toString(),
      legs: quote.legs.map((l) => ({
        sourceRef: l.sourceRef,
        outcome: l.outcome,
        probabilityPPM: l.probabilityPPM.toString(),
        cutoffTime: l.cutoffTime.toString(),
        earliestResolve: l.earliestResolve.toString(),
        oracleAdapter: l.oracleAdapter,
      })),
      deadline: quote.deadline.toString(),
      nonce: quote.nonce.toString(),
    },
    signature,
    signer: account.address,
  });
}
