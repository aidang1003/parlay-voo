import type { RiskProfile } from "~~/utils/parlay";

export const RISK_CAPS: Record<RiskProfile, { maxKelly: number; maxLegs: number; minWinProb: number }> = {
  conservative: { maxKelly: 0.05, maxLegs: 3, minWinProb: 0.15 },
  moderate: { maxKelly: 0.15, maxLegs: 4, minWinProb: 0.05 },
  aggressive: { maxKelly: 1.0, maxLegs: 5, minWinProb: 0.0 },
};
