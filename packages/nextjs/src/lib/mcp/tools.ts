import { createPublicClient, http, formatUnits, type Abi } from "viem";
import { baseSepolia, foundry } from "viem/chains";
import {
  computeMultiplier,
  applyFee,
  applyCorrelation,
  computePayout,
  PPM,
  USDC_DECIMALS,
  PROTOCOL_FEE_BPS,
  CORRELATION_ASYMPTOTE_BPS,
  CORRELATION_HALF_SAT_PPM,
  MAX_LEGS_PER_GROUP,
  RiskAction,
  SEED_MARKETS,
  LOCAL_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  getRpcUrl,
  type SupportedChainId,
} from "@parlayvoo/shared";
import type { RiskProfile, Market, Leg } from "@parlayvoo/shared";
import deployedContracts from "../../contracts/deployedContracts";
import { fetchMarketsFromDb, parsePolySourceRef } from "../polymarket/markets";
import { getRegisteredActiveMarkets } from "../db/client";
import { RISK_CAPS } from "../risk";

const chainId = Number(
  process.env.NEXT_PUBLIC_CHAIN_ID ?? String(BASE_SEPOLIA_CHAIN_ID),
) as SupportedChainId;
const chain = chainId === LOCAL_CHAIN_ID ? foundry : baseSepolia;
const rpcUrl = getRpcUrl(chainId);

const client = createPublicClient({ chain, transport: http(rpcUrl) });

const chainContracts =
  (deployedContracts[chainId as keyof typeof deployedContracts] ??
    Object.values(deployedContracts)[0]) as Record<string, { address: `0x${string}`; abi: Abi }>;

const HOUSE_VAULT_ABI: Abi = chainContracts.HouseVault?.abi ?? [];
const LEG_REGISTRY_ABI: Abi = chainContracts.LegRegistry?.abi ?? [];
const PARLAY_ENGINE_ABI: Abi = chainContracts.ParlayEngine?.abi ?? [];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const addr = {
  houseVault: chainContracts.HouseVault?.address ?? ZERO_ADDRESS,
  parlayEngine: chainContracts.ParlayEngine?.address ?? ZERO_ADDRESS,
  legRegistry: chainContracts.LegRegistry?.address ?? ZERO_ADDRESS,
  usdc: chainContracts.MockUSDC?.address ?? ZERO_ADDRESS,
};

// seed legs (1..21) are static; polymarket legs merge in via refreshLegMap()
export const LEG_MAP = new Map<number, Leg & { category: string }>();
for (const m of SEED_MARKETS) {
  for (const leg of m.legs) {
    LEG_MAP.set(leg.id, { ...leg, category: m.category });
  }
}

/** Re-merges polymarket entries; seed IDs (≤ SEED_CATALOG_MAX) are immutable. */
const SEED_CATALOG_MAX = 21;
export async function refreshLegMap(): Promise<void> {
  for (const id of LEG_MAP.keys()) {
    if (id > SEED_CATALOG_MAX) LEG_MAP.delete(id);
  }
  try {
    const rows = await getRegisteredActiveMarkets();
    for (const row of rows) {
      if (row.txtsource !== "polymarket") continue;
      const parsed = parsePolySourceRef(row.txtsourceref);
      if (!parsed) continue;
      if (row.intyeslegid != null) {
        LEG_MAP.set(row.intyeslegid, {
          id: row.intyeslegid,
          question: `${row.txtquestion} — YES`,
          sourceRef: row.txtsourceref,
          cutoffTime: row.bigcutofftime,
          earliestResolve: row.bigearliestresolve,
          probabilityPPM: row.intyesprobppm,
          active: row.blnactive,
          category: row.txtcategory,
        });
      }
      if (row.intnolegid != null && row.intnoprobppm != null) {
        LEG_MAP.set(row.intnolegid, {
          id: row.intnolegid,
          question: `${row.txtquestion} — NO`,
          sourceRef: row.txtsourceref,
          cutoffTime: row.bigcutofftime,
          earliestResolve: row.bigearliestresolve,
          probabilityPPM: row.intnoprobppm,
          active: row.blnactive,
          category: row.txtcategory,
        });
      }
    }
  } catch (e) {
    // DB unreachable falls back to seed-only quoting
    console.warn("[refreshLegMap] polymarket DB read failed:", e instanceof Error ? e.message : e);
  }
}

export async function listMarkets(input: { category?: string }): Promise<{
  markets: Array<{
    id: string;
    title: string;
    description: string;
    category: string;
    legs: Array<{ id: number; question: string; probabilityPPM: number; impliedOdds: string }>;
  }>;
  totalLegs: number;
}> {
  let markets: Market[] = await fetchMarketsFromDb().catch(() => [...SEED_MARKETS] as Market[]);
  if (input.category) {
    markets = markets.filter((m) => m.category === input.category);
  }
  const mapped = markets.map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    category: m.category,
    legs: m.legs.map((l) => ({
      id: l.id,
      question: l.question,
      probabilityPPM: l.probabilityPPM,
      impliedOdds: `${((l.probabilityPPM / PPM) * 100).toFixed(1)}%`,
    })),
  }));
  const totalLegs = mapped.reduce((sum, m) => sum + m.legs.length, 0);
  return { markets: mapped, totalLegs };
}

export async function getQuote(input: {
  legIds: number[];
  stake: number;
}): Promise<{
  valid: boolean;
  multiplier: string;
  potentialPayout: string;
  legs: Array<{ id: number; question: string; probabilityPPM: number }>;
  error?: string;
}> {
  await refreshLegMap();
  const legs: Array<{ id: number; question: string; probabilityPPM: number }> = [];
  const probs: number[] = [];
  const groupCounts = new Map<number, number>();

  for (const id of input.legIds) {
    const leg = LEG_MAP.get(id);
    if (!leg) {
      return {
        valid: false,
        multiplier: "0",
        potentialPayout: "0",
        legs: [],
        error: `Leg ${id} not found`,
      };
    }
    legs.push({ id: leg.id, question: leg.question, probabilityPPM: leg.probabilityPPM });
    probs.push(leg.probabilityPPM);
    const corrId = leg.correlationGroupId ?? 0;
    if (corrId !== 0) {
      groupCounts.set(corrId, (groupCounts.get(corrId) ?? 0) + 1);
    }
  }

  if (probs.length < 2 || probs.length > 5) {
    return {
      valid: false,
      multiplier: "0",
      potentialPayout: "0",
      legs,
      error: `Need 2-5 legs, got ${probs.length}`,
    };
  }

  const groupSizes = Array.from(groupCounts.values());
  const stakeRaw = BigInt(Math.round(input.stake * 10 ** USDC_DECIMALS));
  const fairMult = computeMultiplier(probs);
  const feeAdjusted = applyFee(fairMult, probs.length, PROTOCOL_FEE_BPS);
  const netMult = applyCorrelation(feeAdjusted, groupSizes, CORRELATION_ASYMPTOTE_BPS, CORRELATION_HALF_SAT_PPM);
  const payout = computePayout(stakeRaw, netMult);

  return {
    valid: true,
    multiplier: `${(Number(netMult) / PPM).toFixed(2)}x`,
    potentialPayout: `${formatUnits(payout, USDC_DECIMALS)} USDC`,
    legs,
  };
}

export async function getVaultHealth(): Promise<{
  totalAssets: string;
  totalReserved: string;
  freeLiquidity: string;
  utilizationPercent: string;
  chainId: number;
  error?: string;
}> {
  if (!addr.houseVault) {
    return {
      totalAssets: "N/A",
      totalReserved: "N/A",
      freeLiquidity: "N/A",
      utilizationPercent: "N/A",
      chainId,
      error: "HouseVault address not configured",
    };
  }

  try {
    const [totalAssets, totalReserved, free] = await Promise.all([
      client.readContract({
        address: addr.houseVault,
        abi: HOUSE_VAULT_ABI,
        functionName: "totalAssets",
      }) as Promise<bigint>,
      client.readContract({
        address: addr.houseVault,
        abi: HOUSE_VAULT_ABI,
        functionName: "totalReserved",
      }) as Promise<bigint>,
      client.readContract({
        address: addr.houseVault,
        abi: HOUSE_VAULT_ABI,
        functionName: "freeLiquidity",
      }) as Promise<bigint>,
    ]);

    const utilPct =
      totalAssets > 0n
        ? `${((Number(totalReserved) / Number(totalAssets)) * 100).toFixed(2)}%`
        : "0.00%";

    return {
      totalAssets: `${formatUnits(totalAssets, USDC_DECIMALS)} USDC`,
      totalReserved: `${formatUnits(totalReserved, USDC_DECIMALS)} USDC`,
      freeLiquidity: `${formatUnits(free, USDC_DECIMALS)} USDC`,
      utilizationPercent: utilPct,
      chainId,
    };
  } catch (e) {
    return {
      totalAssets: "N/A",
      totalReserved: "N/A",
      freeLiquidity: "N/A",
      utilizationPercent: "N/A",
      chainId,
      error: `Failed to read vault: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function getLegStatus(input: { legId: number }): Promise<{
  legId: number;
  question: string;
  sourceRef: string;
  probabilityPPM: number;
  active: boolean;
  onChain: boolean;
  error?: string;
}> {
  await refreshLegMap();
  const seedLeg = LEG_MAP.get(input.legId);

  if (!addr.legRegistry) {
    return {
      legId: input.legId,
      question: seedLeg?.question ?? "Unknown",
      sourceRef: seedLeg?.sourceRef ?? "Unknown",
      probabilityPPM: seedLeg?.probabilityPPM ?? 0,
      active: seedLeg?.active ?? false,
      onChain: false,
      error: "LegRegistry address not configured",
    };
  }

  try {
    const result = (await client.readContract({
      address: addr.legRegistry,
      abi: LEG_REGISTRY_ABI,
      functionName: "getLeg",
      args: [BigInt(input.legId)],
    })) as {
      question: string;
      sourceRef: string;
      cutoffTime: bigint;
      earliestResolve: bigint;
      oracleAdapter: string;
      probabilityPPM: bigint;
      active: boolean;
    };

    return {
      legId: input.legId,
      question: result.question,
      sourceRef: result.sourceRef,
      probabilityPPM: Number(result.probabilityPPM),
      active: result.active,
      onChain: true,
    };
  } catch {
    return {
      legId: input.legId,
      question: seedLeg?.question ?? "Unknown",
      sourceRef: seedLeg?.sourceRef ?? "Unknown",
      probabilityPPM: seedLeg?.probabilityPPM ?? 0,
      active: seedLeg?.active ?? false,
      onChain: false,
      error: "Leg not found on-chain (may not be registered yet)",
    };
  }
}

export async function assessRisk(input: {
  legIds: number[];
  stake: number;
  bankroll?: number;
}): Promise<{
  action: string;
  suggestedStake: string;
  kellyFraction: number;
  winProbability: number;
  expectedValue: number;
  reasoning: string;
  warnings: string[];
  multiplier: string;
}> {
  await refreshLegMap();
  const probs: number[] = [];
  const categories: string[] = [];
  const groupCounts = new Map<number, number>();

  for (const id of input.legIds) {
    const leg = LEG_MAP.get(id);
    if (!leg) {
      return {
        action: RiskAction.AVOID,
        suggestedStake: "0.00",
        kellyFraction: 0,
        winProbability: 0,
        expectedValue: 0,
        reasoning: `Leg ${id} not found`,
        warnings: [],
        multiplier: "0x",
      };
    }
    probs.push(leg.probabilityPPM);
    categories.push(leg.category);
    const corrId = leg.correlationGroupId ?? 0;
    if (corrId !== 0) {
      groupCounts.set(corrId, (groupCounts.get(corrId) ?? 0) + 1);
    }
  }

  const riskTolerance: RiskProfile = "moderate";
  const bankroll = input.bankroll ?? 1000;
  const caps = RISK_CAPS[riskTolerance];
  const numLegs = probs.length;
  const groupSizes = Array.from(groupCounts.values());
  const warnings: string[] = [];

  let fairMultiplierX1e6: bigint;
  try {
    fairMultiplierX1e6 = computeMultiplier(probs);
  } catch {
    return {
      action: RiskAction.AVOID,
      suggestedStake: "0.00",
      kellyFraction: 0,
      winProbability: 0,
      expectedValue: 0,
      reasoning: "Invalid probabilities",
      warnings: [],
      multiplier: "0x",
    };
  }

  if (fairMultiplierX1e6 > 9007199254740991n) {
    return {
      action: RiskAction.AVOID,
      suggestedStake: "0.00",
      kellyFraction: 0,
      winProbability: 0,
      expectedValue: 0,
      reasoning: "Multiplier too large -- parlay is extremely unlikely to win",
      warnings: [],
      multiplier: "overflow",
    };
  }

  const feeAdjusted = applyFee(fairMultiplierX1e6, numLegs, PROTOCOL_FEE_BPS);
  const netMultiplierX1e6 = applyCorrelation(
    feeAdjusted,
    groupSizes,
    CORRELATION_ASYMPTOTE_BPS,
    CORRELATION_HALF_SAT_PPM,
  );
  const fairMultFloat = Number(fairMultiplierX1e6) / PPM;
  const netMultFloat = Number(netMultiplierX1e6) / PPM;
  const winProbability = 1 / fairMultFloat;
  const ev = winProbability * netMultFloat - 1;
  const expectedValue = Math.round(ev * input.stake * 100) / 100;

  const b = netMultFloat - 1;
  const p = winProbability;
  const q = 1 - p;
  let kellyFraction = b > 0 ? Math.max(0, (b * p - q) / b) : 0;
  kellyFraction = Math.min(kellyFraction, caps.maxKelly);
  const suggestedStake = Math.round(kellyFraction * bankroll * 100) / 100;

  if (numLegs > caps.maxLegs) {
    warnings.push(`Moderate profile recommends max ${caps.maxLegs} legs, you have ${numLegs}`);
  }
  if (winProbability < caps.minWinProb) {
    warnings.push(`Win probability ${(winProbability * 100).toFixed(2)}% is below moderate minimum of ${(caps.minWinProb * 100).toFixed(0)}%`);
  }

  // soft signal only — on-chain correlationGroupId is authoritative
  const catCounts: Record<string, number> = {};
  for (const cat of categories) {
    catCounts[cat] = (catCounts[cat] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(catCounts)) {
    if (count > 1) {
      warnings.push(`${count} legs in category "${cat}" may be correlated`);
    }
  }

  let action: string = RiskAction.BUY;
  let reasoning = "";

  if (winProbability < caps.minWinProb || numLegs > caps.maxLegs) {
    action = RiskAction.AVOID;
    reasoning = `${numLegs}-leg parlay at ${(winProbability * 100).toFixed(2)}% win probability exceeds moderate risk tolerance.`;
  } else if (kellyFraction === 0) {
    action = RiskAction.REDUCE_STAKE;
    reasoning = `Net multiplier (${netMultFloat.toFixed(2)}x) leaves no positive Kelly edge. Kelly suggests $0.`;
  } else if (suggestedStake < input.stake) {
    action = RiskAction.REDUCE_STAKE;
    reasoning = `Kelly suggests ${suggestedStake.toFixed(2)} USDC (${(kellyFraction * 100).toFixed(2)}% of bankroll). Your proposed ${input.stake} USDC exceeds this.`;
  } else {
    reasoning = `${numLegs}-leg parlay at ${(winProbability * 100).toFixed(2)}% win probability. Kelly suggests ${(kellyFraction * 100).toFixed(2)}% of bankroll = ${suggestedStake.toFixed(2)} USDC.`;
  }

  return {
    action,
    suggestedStake: suggestedStake.toFixed(2),
    kellyFraction: Math.round(kellyFraction * 10_000) / 10_000,
    winProbability: Math.round(winProbability * 1_000_000) / 1_000_000,
    expectedValue,
    reasoning,
    warnings,
    multiplier: `${netMultFloat.toFixed(2)}x`,
  };
}

export async function getProtocolConfig(): Promise<{
  chain: { id: number; name: string };
  contracts: Record<string, string>;
  fee: { protocolFeeBps: number };
  correlation: { asymptoteBps: number; halfSatPpm: number; maxLegsPerGroup: number };
  limits: { minLegs: number; maxLegs: number; minStakeUSDC: number; maxUtilizationBps: number; maxPayoutBps: number };
}> {
  return {
    chain: { id: chainId, name: chain.name },
    contracts: {
      houseVault: addr.houseVault,
      parlayEngine: addr.parlayEngine,
      legRegistry: addr.legRegistry,
      usdc: addr.usdc,
    },
    fee: { protocolFeeBps: PROTOCOL_FEE_BPS },
    correlation: {
      asymptoteBps: CORRELATION_ASYMPTOTE_BPS,
      halfSatPpm: CORRELATION_HALF_SAT_PPM,
      maxLegsPerGroup: MAX_LEGS_PER_GROUP,
    },
    limits: {
      minLegs: 2,
      maxLegs: 5,
      minStakeUSDC: 1,
      maxUtilizationBps: 8000,
      maxPayoutBps: 500,
    },
  };
}
