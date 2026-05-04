import type { LegSide } from "./build-legs";

export interface SignedQuoteLeg {
  sourceRef: string;
  outcome: `0x${string}`;
  probabilityPPM: string;
  cutoffTime: string;
  earliestResolve: string;
  oracleAdapter: `0x${string}`;
}

export interface SignedQuote {
  buyer: `0x${string}`;
  stake: string;
  legs: SignedQuoteLeg[];
  deadline: string;
  nonce: string;
}

export interface SignedQuoteResponse {
  quote: SignedQuote;
  signature: `0x${string}`;
}

export interface SignedQuoteArg {
  buyer: `0x${string}`;
  stake: bigint;
  legs: Array<{
    sourceRef: string;
    outcome: `0x${string}`;
    probabilityPPM: bigint;
    cutoffTime: bigint;
    earliestResolve: bigint;
    oracleAdapter: `0x${string}`;
  }>;
  deadline: bigint;
  nonce: bigint;
}

/** Fetch an EIP-712 signed Quote from /api/quote-sign. Throws on non-2xx. */
export async function fetchSignedQuote(
  buyer: `0x${string}`,
  stake: bigint,
  legs: Array<{ sourceRef: string; side: LegSide }>,
): Promise<SignedQuoteResponse> {
  const res = await fetch("/api/quote-sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buyer, stake: stake.toString(), legs }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Quote sign failed: ${msg}`);
  }
  return (await res.json()) as SignedQuoteResponse;
}

/** Convert the wire-format SignedQuote (strings) into the bigint-shaped struct
 *  ParlayEngine.buyTicketSigned / buyLosslessParlay expect. */
export function toQuoteArg(quote: SignedQuote): SignedQuoteArg {
  return {
    buyer: quote.buyer,
    stake: BigInt(quote.stake),
    legs: quote.legs.map(l => ({
      sourceRef: l.sourceRef,
      outcome: l.outcome,
      probabilityPPM: BigInt(l.probabilityPPM),
      cutoffTime: BigInt(l.cutoffTime),
      earliestResolve: BigInt(l.earliestResolve),
      oracleAdapter: l.oracleAdapter,
    })),
    deadline: BigInt(quote.deadline),
    nonce: BigInt(quote.nonce),
  };
}
