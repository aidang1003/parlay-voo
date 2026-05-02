export const USDC_DECIMALS = 6;
export const PPM = 1_000_000;
export const BPS = 10_000;
export const MAX_LEGS = 5;
export const MIN_LEGS = 2;
export const MIN_STAKE_USDC = 1;
export const OPTIMISTIC_LIVENESS_SECONDS = 1800;
export const OPTIMISTIC_BOND_USDC = 10;
export const MAX_UTILIZATION_BPS = 8000;
export const MAX_PAYOUT_BPS = 500;
export const BASE_CASHOUT_PENALTY_BPS = 1500; // 15% base penalty, scaled by unresolved/total legs

// Correlation engine knobs. See docs/changes/CORRELATION.md.
// `process.env.NEXT_PUBLIC_*` overrides at build/deploy time; tests + CI use the fallbacks.
function envInt(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const PROTOCOL_FEE_BPS = envInt("NEXT_PUBLIC_PROTOCOL_FEE_BPS", 1000);
export const CORRELATION_ASYMPTOTE_BPS = envInt("NEXT_PUBLIC_CORRELATION_ASYMPTOTE_BPS", 8000);
export const CORRELATION_HALF_SAT_PPM = envInt("NEXT_PUBLIC_CORRELATION_HALF_SAT_PPM", 1_000_000);
export const MAX_LEGS_PER_GROUP = envInt("NEXT_PUBLIC_MAX_LEGS_PER_GROUP", 3);

// Chain IDs live in chains.ts — import from there.
