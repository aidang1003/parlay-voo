import { NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, isAddress, type Hex } from "viem";
import { getActiveMarkets } from "@/lib/db/client";
import { PolymarketClient } from "@/lib/polymarket/client";
import { parsePolySourceRef, midToPpm } from "@/lib/polymarket/markets";
import deployedContracts from "@/contracts/deployedContracts";
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

const YES_OUTCOME = ("0x" + "01".padStart(64, "0")) as Hex;
const NO_OUTCOME  = ("0x" + "02".padStart(64, "0")) as Hex;

interface LegInput {
  sourceRef: string;
  side: "yes" | "no";
}

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

  const markets = await getActiveMarkets();
  const bySourceRef = new Map(markets.map((m) => [m.txtsourceref, m]));

  const poly = new PolymarketClient({
    gammaUrl: process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com",
    clobUrl: process.env.POLYMARKET_CLOB_URL ?? "https://clob.polymarket.com",
  });

  const signedLegs: Array<{
    sourceRef: string;
    outcome: Hex;
    probabilityPPM: bigint;
    cutoffTime: bigint;
    earliestResolve: bigint;
    oracleAdapter: `0x${string}`;
  }> = [];

  for (const leg of body.legs) {
    const row = bySourceRef.get(leg.sourceRef);
    if (!row) return NextResponse.json({ error: `unknown leg ${leg.sourceRef}` }, { status: 400 });

    const isNo = leg.side === "no";
    if (isNo && row.intnoprobppm == null) {
      return NextResponse.json({ error: `no-side unavailable for ${leg.sourceRef}` }, { status: 400 });
    }

    // Default PPM from DB (already YES-side for both; contract flips for no-bets).
    let yesPpm = row.intyesprobppm;

    // For polymarket legs, refresh the mid from CLOB.
    if (row.txtsource === "polymarket") {
      const parsed = parsePolySourceRef(leg.sourceRef);
      if (parsed) {
        try {
          const market = await poly.fetchMarket(parsed.conditionId);
          const book = await poly.fetchOrderBook(market.yesTokenId);
          const bestBid = Number(book.bids[0]?.price ?? 0);
          const bestAsk = Number(book.asks[0]?.price ?? 0);
          if (bestBid > 0 && bestAsk > 0) {
            const mid = (bestBid + bestAsk) / 2;
            yesPpm = midToPpm(mid);
          }
        } catch {
          // Fall back to DB PPM — don't fail the quote if CLOB is flaky.
        }
      }
    }

    signedLegs.push({
      sourceRef: leg.sourceRef,
      outcome: isNo ? NO_OUTCOME : YES_OUTCOME,
      probabilityPPM: BigInt(yesPpm),
      cutoffTime: BigInt(row.bigcutofftime),
      earliestResolve: BigInt(row.bigearliestresolve),
      oracleAdapter: getAddress(oracleAddr),
    });
  }

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
