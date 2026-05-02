"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { useModal } from "connectkit";
import type { Leg, Market } from "@parlayvoo/shared";
import {
  MAX_LEGS,
  MIN_LEGS,
  MIN_STAKE_USDC,
  PROTOCOL_FEE_BPS,
  CORRELATION_ASYMPTOTE_BPS,
  CORRELATION_HALF_SAT_PPM,
  MAX_LEGS_PER_GROUP,
  PPM,
  BPS,
  applyFee,
  applyCorrelation,
  computeMultiplier,
} from "@parlayvoo/shared";
import {
  sanitizeNumericInput,
  blockNonNumericKeys,
  useSessionState,
} from "@/lib/utils";
import {
  useBuyTicket,
  useBuyLosslessParlay,
  useCreditBalance,
  useParlayConfig,
  useUSDCBalance,
  useVaultStats,
  useMintTestUSDC,
  useLegDescriptions,
  useLegStatuses,
} from "@/lib/hooks";
import { MultiplierClimb } from "./MultiplierClimb";

// ── Types ────────────────────────────────────────────────────────────────

/** Display-ready leg combining API data with UI state. One DisplayLeg now
 *  represents an entire market (both yes/no sides collapsed). For seed markets
 *  noId is undefined so the UI hides the No button. */
interface DisplayLeg {
  /** Yes-side on-chain leg id (used when outcomeChoice === 1). */
  id: bigint;
  /** No-side on-chain leg id (used when outcomeChoice === 2). Absent for
   *  single-sided seed markets. */
  noId?: bigint;
  description: string;
  yesOdds: number; // decimal multiplier for yes side
  noOdds?: number; // decimal multiplier for no side (poly only)
  resolved: boolean;
  outcome: number;
  expiresAt: number;
  category: string;
  marketTitle: string;
  gameGroup: string;
  /** Whether this leg has an on-chain counterpart (can be bought). */
  onChain: boolean;
  /** Raw source reference: polymarket conditionId (0x…) or "seed:<id>". */
  sourceRef: string;
  /** Yes-side probability in PPM (used for accurate multiplier computation). */
  yesProbabilityPPM: number;
  /** No-side probability in PPM. */
  noProbabilityPPM?: number;
  /** Correlation group id (0 = uncorrelated). */
  correlationGroupId: number;
  /** Mutual-exclusion group id (0 = no exclusion). */
  exclusionGroupId: number;
}

interface SelectedLeg {
  leg: DisplayLeg;
  outcomeChoice: number; // 1 = yes, 2 = no
}

/** Serializable form for sessionStorage (bigint is not JSON-safe). */
interface StoredSelection {
  legId: string; // BigInt.toString()
  outcomeChoice: number;
}

// Kelly AI Risk Advisor — calls /api/premium/agent-quote to return Kelly-sized
// stake suggestions, EV/edge metrics, and an optional 0G AI insight.
// DISABLED: no longer called by the application. Kept here so we can re-enable
// the feature later without rebuilding the typings/validator from scratch.
/*
interface RiskAdviceData {
  action: string;
  suggestedStake: string;
  kellyFraction: number;
  winProbability: number;
  expectedValue: number;
  confidence: number;
  fairMultiplier: number;
  netMultiplier: number;
  edgeBps: number;
  riskTolerance: string;
  reasoning: string;
  warnings: string[];
  aiInsight?: { analysis: string; model: string; provider: string; verified: boolean };
}
*/

// ── Constants ─────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  all: "Featured",
  crypto: "Crypto",
  defi: "DeFi",
  nft: "NFT",
  policy: "Policy",
  economics: "Economics",
  trivia: "Trivia",
  ethdenver: "ETHDenver",
  nba: "NBA",
  nfl: "NFL",
  mlb: "MLB",
  nhl: "NHL",
};

const CATEGORY_COLORS: Record<string, string> = {
  crypto: "bg-brand-purple/15 text-brand-purple-1 border-brand-purple/30",
  defi: "bg-brand-blue/15 text-brand-blue border-brand-blue/30",
  nft: "bg-brand-pink/15 text-brand-pink border-brand-pink/30",
  policy: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  economics: "bg-neon-green/15 text-neon-green border-neon-green/30",
  trivia: "bg-brand-amber/15 text-brand-amber border-brand-amber/30",
  ethdenver: "bg-brand-pink/15 text-brand-pink border-brand-pink/30",
  nba: "bg-brand-amber/15 text-brand-amber border-brand-amber/30",
  nfl: "bg-brand-amber/15 text-brand-amber border-brand-amber/30",
  mlb: "bg-brand-amber/15 text-brand-amber border-brand-amber/30",
  nhl: "bg-brand-amber/15 text-brand-amber border-brand-amber/30",
};

// ── Session storage keys ─────────────────────────────────────────────────

const SESSION_KEYS = {
  legs: "parlay:selectedLegs",
  stake: "parlay:stake",
  category: "parlay:category",
} as const;

// ── Pure helpers ─────────────────────────────────────────────────────────

/** PPM to decimal odds. */
function ppmToOdds(ppm: number): number {
  if (ppm <= 0) return 1;
  return 1_000_000 / ppm;
}

/** Pick the odds for the selected side. Falls back to complement if the no-side
 *  odds weren't supplied (single-sided seed markets clicked as "no" shouldn't
 *  happen because the No button is hidden, but we guard anyway). */
function effectiveOdds(leg: DisplayLeg, outcome: number): number {
  if (outcome === 2) {
    if (leg.noOdds !== undefined) return leg.noOdds;
    if (leg.yesOdds <= 1) return leg.yesOdds;
    return leg.yesOdds / (leg.yesOdds - 1);
  }
  return leg.yesOdds;
}

/** Transform API markets into DisplayLeg array — one leg per market. Both
 *  yes/no sides get collapsed into a single card; the noId/noOdds fields
 *  carry the second side when present. */
function apiMarketsToLegs(markets: Market[]): DisplayLeg[] {
  const legs: DisplayLeg[] = [];
  for (const market of markets) {
    for (const leg of market.legs) {
      legs.push({
        id: BigInt(leg.id),
        noId: leg.noId !== undefined ? BigInt(leg.noId) : undefined,
        description: leg.question,
        yesOdds: ppmToOdds(leg.probabilityPPM),
        noOdds: leg.noProbabilityPPM !== undefined ? ppmToOdds(leg.noProbabilityPPM) : undefined,
        resolved: false,
        outcome: 0,
        expiresAt: leg.cutoffTime,
        category: market.category,
        marketTitle: market.title,
        gameGroup: market.gameGroup ?? "",
        onChain: false,
        sourceRef: leg.sourceRef,
        yesProbabilityPPM: leg.probabilityPPM,
        noProbabilityPPM: leg.noProbabilityPPM,
        correlationGroupId: leg.correlationGroupId ?? 0,
        exclusionGroupId: leg.exclusionGroupId ?? 0,
      });
    }
  }
  return legs;
}

/** Restore SelectedLeg[] from serialized form. */
function restoreSelections(stored: StoredSelection[], allLegs: DisplayLeg[]): SelectedLeg[] {
  const legMap = new Map(allLegs.map((l) => [l.id.toString(), l]));
  const result: SelectedLeg[] = [];
  for (const s of stored) {
    const leg = legMap.get(s.legId);
    if (leg && (s.outcomeChoice === 1 || s.outcomeChoice === 2)) {
      result.push({ leg, outcomeChoice: s.outcomeChoice });
    }
  }
  return result;
}

// Risk advisor response validator. DISABLED along with the Kelly AI Risk
// Advisor feature — no longer called by the application.
/*
function isValidRiskResponse(data: unknown): data is RiskAdviceData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  const baseValid =
    typeof d.action === "string" &&
    typeof d.suggestedStake === "string" &&
    /^\d+(?:\.\d*)?$/.test(d.suggestedStake) &&
    typeof d.kellyFraction === "number" &&
    typeof d.winProbability === "number" &&
    typeof d.expectedValue === "number" &&
    typeof d.confidence === "number" &&
    typeof d.fairMultiplier === "number" &&
    typeof d.netMultiplier === "number" &&
    typeof d.edgeBps === "number" &&
    typeof d.riskTolerance === "string" &&
    typeof d.reasoning === "string" &&
    Array.isArray(d.warnings) &&
    d.warnings.every((w: unknown) => typeof w === "string");
  if (!baseValid) return false;
  if (d.aiInsight !== undefined && d.aiInsight !== null) {
    const ai = d.aiInsight as Record<string, unknown>;
    if (typeof ai.analysis !== "string" || typeof ai.model !== "string" || typeof ai.provider !== "string") return false;
  }
  return true;
}
*/

// ── Component ────────────────────────────────────────────────────────────

export function ParlayBuilder() {
  const { isConnected } = useAccount();
  const { setOpen: openConnectModal } = useModal();
  const buyHook = useBuyTicket();
  const losslessHook = useBuyLosslessParlay();
  const { credit } = useCreditBalance();
  const [useLossless, setUseLossless] = useState(false);
  const { balance: usdcBalance } = useUSDCBalance();
  const mintHook = useMintTestUSDC();
  const { freeLiquidity, maxPayout } = useVaultStats();
  const {
    protocolFeeBps,
    correlationAsymptoteBps,
    correlationHalfSatPpm,
    maxLegsPerGroup,
    maxLegs,
    minStakeUSDC,
  } = useParlayConfig();

  // Pick the active purchase hook so every downstream state read stays in sync
  // with whichever flow the user is currently on.
  const { buyTicket, resetSuccess, isPending, isConfirming, isSuccess, error, lastTicketId } =
    useLossless
      ? {
          buyTicket: losslessHook.buyLossless,
          resetSuccess: losslessHook.resetSuccess,
          isPending: losslessHook.isPending,
          isConfirming: losslessHook.isConfirming,
          isSuccess: losslessHook.isSuccess,
          error: losslessHook.error,
          lastTicketId: losslessHook.lastTicketId,
        }
      : buyHook;

  // ── Market data state ───────────────────────────────────────────────────

  const [allLegs, setAllLegs] = useState<DisplayLeg[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useSessionState<string>(SESSION_KEYS.category, "all");


  // ── Input state (persisted to sessionStorage) ──────────────────────────

  const [selectedLegs, setSelectedLegs] = useState<SelectedLeg[]>([]);
  const [stake, setStake] = useSessionState<string>(SESSION_KEYS.stake, "");
  const [mounted, setMounted] = useState(false);


  // Fetch markets from API
  useEffect(() => {
    setMounted(true);
    let cancelled = false;

    let storedSelections: StoredSelection[] | null = null;
    try {
      const raw = sessionStorage.getItem(SESSION_KEYS.legs);
      if (raw) storedSelections = JSON.parse(raw);
    } catch {
      // parse error or sessionStorage unavailable
    }

    async function fetchMarkets() {
      try {
        const res = await fetch("/api/markets");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const markets: Market[] = await res.json();
        if (cancelled || !Array.isArray(markets)) return;

        const legs = apiMarketsToLegs(markets);
        setAllLegs(legs);
        const cats = [...new Set(markets.map((m) => m.category))].sort();
        setAvailableCategories(cats);

        if (storedSelections && storedSelections.length > 0) {
          const restored = restoreSelections(storedSelections, legs);
          if (restored.length > 0) setSelectedLegs(restored);
        }
      } catch {
        // API unavailable — allLegs stays empty, UI shows empty state
      } finally {
        if (!cancelled) setMarketsLoading(false);
      }
    }

    fetchMarkets();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile selectedLegs when allLegs changes
  useEffect(() => {
    setSelectedLegs((prev) => {
      if (prev.length === 0) return prev;
      const legMap = new Map(allLegs.map((l) => [l.id.toString(), l]));
      let changed = false;
      const reconciled: SelectedLeg[] = [];
      for (const s of prev) {
        const freshLeg = legMap.get(s.leg.id.toString());
        if (freshLeg) {
          if (freshLeg !== s.leg) {
            reconciled.push({ ...s, leg: freshLeg });
            changed = true;
          } else {
            reconciled.push(s);
          }
        } else {
          changed = true;
        }
      }
      return changed ? reconciled : prev;
    });
  }, [allLegs]);

  // Persist selectedLegs to sessionStorage
  useEffect(() => {
    if (!mounted) return;
    try {
      const serialized: StoredSelection[] = selectedLegs.map((s) => ({
        legId: s.leg.id.toString(),
        outcomeChoice: s.outcomeChoice,
      }));
      sessionStorage.setItem(SESSION_KEYS.legs, JSON.stringify(serialized));
    } catch {
      // storage full or unavailable
    }
  }, [mounted, selectedLegs]);

  // ── Live pricing refresh ───────────────────────────────────────────────
  // Every 30s while ≥2 legs are staged and the buy flow is idle, poll
  // /api/quote-preview to refresh CLOB mids. Updates allLegs in place; the
  // reconcile effect above propagates new leg references into selectedLegs,
  // which re-triggers the multiplier useMemo. Paused once the user clicks
  // buy (isPending / isConfirming / isSuccess) — quote-sign does its own
  // final CLOB refetch and becomes the source of truth from that point.
  const selectedLegsKey = useMemo(
    () => selectedLegs.map((s) => `${s.leg.sourceRef}:${s.outcomeChoice}`).join("|"),
    [selectedLegs],
  );
  const buyActive = isPending || isConfirming || isSuccess;

  useEffect(() => {
    if (selectedLegs.length < 2 || buyActive) return;

    const abort = new AbortController();
    let cancelled = false;

    async function refresh() {
      if (cancelled) return;
      try {
        const res = await fetch("/api/quote-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            legs: selectedLegs.map((s) => ({
              sourceRef: s.leg.sourceRef,
              side: s.outcomeChoice === 2 ? "no" : "yes",
            })),
          }),
          signal: abort.signal,
        });
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as {
          legs: Array<{ sourceRef: string; probabilityPPM: number }>;
        };
        const freshBySource = new Map<string, number>(
          data.legs.map((l) => [l.sourceRef, l.probabilityPPM]),
        );

        setAllLegs((prev) => {
          let changed = false;
          const next = prev.map((leg) => {
            const freshYes = freshBySource.get(leg.sourceRef);
            if (freshYes == null) return leg;
            const nextYesOdds = ppmToOdds(freshYes);
            const nextNoOdds = leg.noOdds != null ? ppmToOdds(1_000_000 - freshYes) : leg.noOdds;
            if (nextYesOdds === leg.yesOdds && nextNoOdds === leg.noOdds) return leg;
            changed = true;
            return { ...leg, yesOdds: nextYesOdds, noOdds: nextNoOdds };
          });
          return changed ? next : prev;
        });
      } catch {
        // Silent — next tick retries. Abort errors land here too.
      }
    }

    refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      abort.abort();
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLegsKey, buyActive]);

  // ── Risk advisor state ─────────────────────────────────────────────────
  // Kelly AI Risk Advisor state + stale-data reset.
  // DISABLED: no longer called by the application. Kept for future re-enable.
  /*
  const [riskAdvice, setRiskAdvice] = useState<RiskAdviceData | null>(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskError, setRiskError] = useState<string | null>(null);
  const riskFetchIdRef = useRef(0);
  const [aiInsightExpanded, setAiInsightExpanded] = useState(false);

  useEffect(() => {
    setRiskAdvice(null);
    setRiskError(null);
    setRiskLoading(false);
    setAiInsightExpanded(false);
    riskFetchIdRef.current++;
  }, [selectedLegs, stake]);
  */

  // ── Derived values ─────────────────────────────────────────────────────

  const stakeNum = parseFloat(stake) || 0;
  const effectiveMaxLegs = maxLegs ?? MAX_LEGS;
  const effectiveMinStake = minStakeUSDC ?? MIN_STAKE_USDC;
  const effectiveProtocolFee = protocolFeeBps ?? PROTOCOL_FEE_BPS;
  const effectiveCorrAsymptote = correlationAsymptoteBps ?? CORRELATION_ASYMPTOTE_BPS;
  const effectiveCorrHalfSat = correlationHalfSatPpm ?? CORRELATION_HALF_SAT_PPM;
  const effectiveMaxLegsPerGroup = maxLegsPerGroup ?? MAX_LEGS_PER_GROUP;

  // Pull on-chain status for any DisplayLeg that has a real (non-synthetic)
  // legId. Synthetic ids are negative (set in markets.ts when the row hasn't
  // been JIT-registered yet) and have no oracle to query — skip them.
  const onChainLegIds = useMemo(
    () => allLegs.map((l) => l.id).filter((id) => id >= 0n),
    [allLegs],
  );
  const builderLegMap = useLegDescriptions(onChainLegIds);
  const builderLegStatuses = useLegStatuses(onChainLegIds, builderLegMap, 30_000);

  // Drop legs the oracle has already resolved (status 1/2/3). Buying them
  // would revert at quote-sign time; nothing the user can do with them.
  const liveLegs = useMemo(() => {
    if (builderLegStatuses.size === 0) return allLegs;
    return allLegs.filter((l) => {
      if (l.id < 0n) return true;
      const status = builderLegStatuses.get(l.id.toString());
      return !status?.resolved;
    });
  }, [allLegs, builderLegStatuses]);

  const filteredLegs = useMemo(() => {
    if (activeCategory === "all") return liveLegs;
    return liveLegs.filter((l) => l.category === activeCategory);
  }, [liveLegs, activeCategory]);

  useEffect(() => {
    if (
      activeCategory !== "all" &&
      allLegs.length > 0 &&
      filteredLegs.length === 0
    ) {
      setActiveCategory("all");
    }
  }, [activeCategory, allLegs.length, filteredLegs.length, setActiveCategory]);

  const groupedByGame = useMemo(() => {
    const games: {
      gameGroup: string;
      markets: { title: string; legs: DisplayLeg[] }[];
    }[] = [];
    const gameIx = new Map<string, number>();
    const marketIx = new Map<string, Map<string, number>>();

    for (const leg of filteredLegs) {
      const key = leg.gameGroup;
      let gi = gameIx.get(key);
      if (gi === undefined) {
        gi = games.length;
        gameIx.set(key, gi);
        games.push({ gameGroup: key, markets: [] });
        marketIx.set(key, new Map());
      }
      const perMarket = marketIx.get(key)!;
      let mi = perMarket.get(leg.marketTitle);
      if (mi === undefined) {
        mi = games[gi].markets.length;
        perMarket.set(leg.marketTitle, mi);
        games[gi].markets.push({ title: leg.marketTitle, legs: [] });
      }
      games[gi].markets[mi].legs.push(leg);
    }
    return games;
  }, [filteredLegs]);

  // Final multiplier: applies the per-leg fee and saturating correlation
  // discount via the same shared math the engine runs on-chain.
  const multiplier = useMemo(() => {
    if (selectedLegs.length === 0) return 1;
    const probs = selectedLegs.map((s) =>
      s.outcomeChoice === 2
        ? (s.leg.noProbabilityPPM ?? PPM - s.leg.yesProbabilityPPM)
        : s.leg.yesProbabilityPPM,
    );
    if (probs.some((p) => p <= 0 || p >= PPM)) {
      // Fall back to pure odds product when any leg has an invalid PPM.
      return selectedLegs.reduce((acc, s) => acc * effectiveOdds(s.leg, s.outcomeChoice), 1);
    }
    const counts = new Map<number, number>();
    for (const s of selectedLegs) {
      const g = s.leg.correlationGroupId;
      if (g !== 0) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    const groupSizes = Array.from(counts.values());
    const fairMul = computeMultiplier(probs);
    const feeAdjusted = applyFee(fairMul, probs.length, effectiveProtocolFee);
    const finalMul = applyCorrelation(
      feeAdjusted,
      groupSizes,
      effectiveCorrAsymptote,
      effectiveCorrHalfSat,
    );
    return Number(finalMul) / PPM;
  }, [selectedLegs, effectiveProtocolFee, effectiveCorrAsymptote, effectiveCorrHalfSat]);

  const potentialPayout = stakeNum * multiplier;

  // Map leg id → disabled reason (null when selectable). The builder uses
  // this to grey out conflicting legs without telling the user there's a
  // correlation-related cap (CORRELATION.md: leg-limit copy stays neutral).
  const legGate = useMemo(() => {
    const gate = new Map<string, { reason: "conflict" | "groupCap"; conflictsWith?: string }>();
    if (selectedLegs.length === 0) return gate;
    const corrCounts = new Map<number, number>();
    const exclusionOwners = new Map<number, DisplayLeg>();
    for (const s of selectedLegs) {
      const cg = s.leg.correlationGroupId;
      if (cg !== 0) corrCounts.set(cg, (corrCounts.get(cg) ?? 0) + 1);
      const eg = s.leg.exclusionGroupId;
      if (eg !== 0) exclusionOwners.set(eg, s.leg);
    }
    for (const leg of allLegs) {
      const idKey = leg.id.toString();
      if (selectedLegs.some((s) => s.leg.id === leg.id)) continue; // already selected — don't gate self
      if (leg.exclusionGroupId !== 0) {
        const owner = exclusionOwners.get(leg.exclusionGroupId);
        if (owner) {
          gate.set(idKey, { reason: "conflict", conflictsWith: owner.description });
          continue;
        }
      }
      if (leg.correlationGroupId !== 0) {
        const count = corrCounts.get(leg.correlationGroupId) ?? 0;
        if (count >= effectiveMaxLegsPerGroup) {
          gate.set(idKey, { reason: "groupCap" });
        }
      }
    }
    return gate;
  }, [allLegs, selectedLegs, effectiveMaxLegsPerGroup]);

  const freeLiquidityNum = freeLiquidity !== undefined ? parseFloat(formatUnits(freeLiquidity, 6)) : 0;
  const maxPayoutNum = maxPayout !== undefined ? parseFloat(formatUnits(maxPayout, 6)) : 0;
  const statsLoaded = maxPayout !== undefined && freeLiquidity !== undefined;
  const exceedsMaxPayout = potentialPayout > 0 && maxPayout !== undefined && potentialPayout > maxPayoutNum;
  const insufficientLiquidity =
    potentialPayout > 0 && freeLiquidity !== undefined && potentialPayout > freeLiquidityNum;

  // Largest stake that keeps potentialPayout under both vault caps for the
  // current leg selection. The on-chain buy reverts when payout exceeds
  // maxPayout() (5% TVL) or freeLiquidity(); capping the UI stake here
  // prevents 4-5 leg parlays from silently reverting after approve.
  const vaultCapUsdc = statsLoaded ? Math.min(maxPayoutNum, freeLiquidityNum) : 0;
  const impliedMaxStake = multiplier > 1 && vaultCapUsdc > 0 ? vaultCapUsdc / multiplier : 0;

  const usdcBalanceNum = usdcBalance !== undefined ? parseFloat(formatUnits(usdcBalance, 6)) : 0;
  const creditNum = credit !== undefined ? parseFloat(formatUnits(credit, 6)) : 0;
  const insufficientBalance =
    stakeNum > 0 &&
    (useLossless
      ? credit !== undefined && stakeNum > creditNum
      : usdcBalance !== undefined && stakeNum > usdcBalanceNum);
  const hasAnyCredit = credit !== undefined && credit > 0n;

  const canBuy =
    mounted &&
    isConnected &&
    statsLoaded &&
    selectedLegs.length >= MIN_LEGS &&
    selectedLegs.length <= effectiveMaxLegs &&
    stakeNum >= effectiveMinStake &&
    !insufficientLiquidity &&
    !exceedsMaxPayout &&
    !insufficientBalance &&
    (!useLossless || hasAnyCredit);

  const vaultEmpty = mounted && freeLiquidity !== undefined && freeLiquidity === 0n;

  // ── Handlers ───────────────────────────────────────────────────────────

  const toggleLeg = useCallback(
    (leg: DisplayLeg, outcome: number) => {
      resetSuccess();
      setSelectedLegs((prev) => {
        const existing = prev.findIndex((s) => s.leg.id === leg.id);
        if (existing >= 0) {
          if (prev[existing].outcomeChoice === outcome) {
            return prev.filter((_, i) => i !== existing);
          }
          const updated = [...prev];
          updated[existing] = { leg, outcomeChoice: outcome };
          return updated;
        }
        if (prev.length >= effectiveMaxLegs) return prev;
        return [...prev, { leg, outcomeChoice: outcome }];
      });
    },
    [resetSuccess, effectiveMaxLegs]
  );

  const handleBuy = async () => {
    if (!canBuy) return;
    const quoteLegs = selectedLegs.map((s) => ({
      sourceRef: s.leg.sourceRef,
      side: (s.outcomeChoice === 2 ? "no" : "yes") as "yes" | "no",
    }));
    const success = await buyTicket(quoteLegs, stakeNum);
    if (success) {
      setSelectedLegs([]);
      setStake("");
    }
  };

  // Kelly AI Risk Advisor fetch + 600ms debounced auto-trigger.
  // Posts the current parlay to /api/premium/agent-quote and renders Kelly
  // sizing, EV/edge, and optional 0G AI insight in the builder.
  // DISABLED: no longer called by the application. Retained so we can turn
  // the feature back on later without re-deriving the fetch/validation logic.
  /*
  const fetchRiskAdvice = useCallback(async () => {
    const localFetchId = ++riskFetchIdRef.current;
    setRiskLoading(true);
    setRiskAdvice(null);
    setRiskError(null);

    try {
      const res = await fetch("/api/premium/agent-quote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-402-payment": process.env.NEXT_PUBLIC_X402_PAYMENT ?? "demo-token",
        },
        body: JSON.stringify({
          legIds: selectedLegs.map((s) => Number(s.leg.id)),
          outcomes: selectedLegs.map((s) => (s.outcomeChoice === 1 ? "Yes" : "No")),
          stake,
          bankroll:
            usdcBalance !== undefined && usdcBalance > 0n
              ? formatUnits(usdcBalance, 6)
              : "100",
          riskTolerance: "moderate",
        }),
      });

      if (localFetchId !== riskFetchIdRef.current) return;

      if (!res.ok) {
        setRiskError(`Risk analysis unavailable (${res.status})`);
        setRiskLoading(false);
        return;
      }

      const raw: unknown = await res.json();
      if (localFetchId !== riskFetchIdRef.current) return;

      const envelope = raw as Record<string, unknown>;
      const riskObj = envelope.risk;
      if (!riskObj || typeof riskObj !== "object") {
        setRiskError("Invalid response from risk advisor");
        setRiskLoading(false);
        return;
      }

      const merged = { ...(riskObj as Record<string, unknown>), ...(envelope.aiInsight ? { aiInsight: envelope.aiInsight } : {}) };

      if (!isValidRiskResponse(merged)) {
        setRiskError("Invalid response from risk advisor");
        setRiskLoading(false);
        return;
      }

      setRiskAdvice(merged);
    } catch {
      if (localFetchId === riskFetchIdRef.current) {
        setRiskError("Failed to connect to risk advisor");
      }
    }

    if (localFetchId === riskFetchIdRef.current) setRiskLoading(false);
  }, [selectedLegs, stake, usdcBalance]);

  const fetchRiskAdviceRef = useRef(fetchRiskAdvice);
  fetchRiskAdviceRef.current = fetchRiskAdvice;

  useEffect(() => {
    if (selectedLegs.length < MIN_LEGS || !(parseFloat(stake) > 0)) return;
    setRiskLoading(true);
    const timer = setTimeout(() => {
      fetchRiskAdviceRef.current();
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLegs, stake]);
  */

  // ── Derived display ────────────────────────────────────────────────────

  const txState = isPending
    ? "pending"
    : isConfirming
      ? "confirming"
      : isSuccess
        ? "confirmed"
        : null;

  function buyButtonLabel(): string {
    if (!mounted || !isConnected) return "Connect Wallet";
    if (isPending) return useLossless ? "Signing..." : "Waiting for approval...";
    if (isConfirming) return "Confirming...";
    if (isSuccess) return "Ticket Bought!";
    if (vaultEmpty) return "No Vault Liquidity";
    if (selectedLegs.length < MIN_LEGS) return `Select at least ${MIN_LEGS} legs`;
    if (useLossless && !hasAnyCredit) return "No promo credit";
    if (insufficientBalance) {
      return useLossless ? "Insufficient Credit" : "Insufficient USDC Balance";
    }
    if (exceedsMaxPayout) return `Max Payout $${maxPayoutNum.toFixed(0)}`;
    if (insufficientLiquidity) return `Insufficient Vault Liquidity ($${freeLiquidityNum.toFixed(0)})`;
    return useLossless ? "Place Lossless Parlay" : "Buy Ticket";
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div id="ftue-builder" className={`grid gap-8 lg:grid-cols-5 ${mounted ? "" : "pointer-events-none opacity-0"}`}>
      {/* Leg selector */}
      <div className="space-y-4 lg:col-span-3">
        {vaultEmpty && (
          <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-yellow-400">
            No liquidity in the vault. Deposit USDC in the Vault tab to enable betting.
          </div>
        )}

        {/* Category filter pills */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setActiveCategory("all")}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition-all ${
              activeCategory === "all"
                ? "gradient-bg text-white shadow-lg shadow-brand-pink/20"
                : "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
            }`}
          >
            Featured
          </button>
          {availableCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-all ${
                activeCategory === cat
                  ? "gradient-bg text-white shadow-lg shadow-brand-pink/20"
                  : "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
              }`}
            >
              {CATEGORY_LABELS[cat] ?? cat}
              {cat === "nba" && (
                <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-neon-green/15 px-1.5 py-0.5 text-[10px] font-bold text-neon-green">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neon-green" />
                  LIVE
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Leg counter: visual dot indicators */}
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-gray-300">
            Pick Your Legs
          </h2>
          <div className="flex gap-1">
            {Array.from({ length: effectiveMaxLegs }, (_, i) => (
              <div
                key={i}
                className={`flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold transition-all ${
                  i < selectedLegs.length
                    ? "gradient-bg text-white shadow-sm"
                    : "bg-white/5 text-gray-600"
                }`}
              >
                {i + 1}
              </div>
            ))}
          </div>
        </div>

        <div className={`space-y-4 ${vaultEmpty ? "pointer-events-none opacity-40" : ""}`}>
          {marketsLoading && allLegs.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
              <div className="mb-3 h-6 w-6 animate-spin rounded-full border-2 border-gray-600 border-t-brand-purple" />
              <p className="text-sm">Loading markets...</p>
            </div>
          )}
          {!marketsLoading && allLegs.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
              <p className="text-sm">No markets available right now.</p>
              <p className="mt-1 text-xs text-gray-600">Check back soon — markets are synced from Polymarket.</p>
            </div>
          )}
          {groupedByGame.map((game) => (
            <div key={`game:${game.gameGroup || "__flat__"}`} className="space-y-3">
              {game.gameGroup && (
                <h2 className="border-b border-white/5 pb-1 text-sm font-bold text-gray-300">
                  {game.gameGroup}
                </h2>
              )}
              {game.markets.map(({ title, legs }) => (
                <div key={`${game.gameGroup}::${title}`} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500">
                      {title}
                    </h3>
                    {legs[0] && (
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                        CATEGORY_COLORS[legs[0].category] ?? "bg-white/10 text-gray-400 border-white/10"
                      }`}>
                        {CATEGORY_LABELS[legs[0].category] ?? legs[0].category}
                      </span>
                    )}
                    {legs[0]?.sourceRef.startsWith("0x") && (
                      <span
                        title="Odds captured when this market was registered on-chain. They don't update mid-flight."
                        className="rounded-full border border-brand-purple/30 bg-brand-purple/10 px-2 py-0.5 text-[10px] font-medium text-brand-purple"
                      >
                        Odds locked
                      </span>
                    )}
                  </div>
                  <div className="space-y-2">
                    {legs.map((leg, legIdx) => {
                  const selected = selectedLegs.find((s) => s.leg.id === leg.id);
                  const hasNo = leg.noId !== undefined;
                  const gateInfo = legGate.get(leg.id.toString());
                  const gated = gateInfo !== undefined && !selected;
                  const tooltip = gated
                    ? gateInfo.reason === "conflict"
                      ? `Conflicts with: ${gateInfo.conflictsWith ?? ""}`
                      : "Leg limit reached"
                    : undefined;
                  return (
                    <div
                      key={leg.id.toString()}
                      id={legIdx === 0 ? "ftue-market-card" : undefined}
                      title={tooltip}
                      className={`animate-market-card-enter glass-card overflow-hidden transition-all ${
                        selected
                          ? selected.outcomeChoice === 1
                            ? "border-brand-green/40 shadow-[0_0_15px_rgba(34,197,94,0.1)]"
                            : "border-brand-amber/40 shadow-[0_0_15px_rgba(245,158,11,0.1)]"
                          : gated
                            ? "opacity-40 grayscale"
                            : "hover:border-white/10"
                      }`}
                      style={{ animationDelay: `${legIdx * 50}ms` }}
                    >
                      {/* Yes / Question / No — question centered, sides flanking */}
                      <div className="flex items-stretch">
                        <button
                          disabled={vaultEmpty || gated}
                          onClick={() => toggleLeg(leg, 1)}
                          className={`flex w-24 flex-shrink-0 flex-col items-center justify-center gap-0.5 px-2 py-3 text-xs font-bold uppercase tracking-wider transition-all ${
                            selected?.outcomeChoice === 1
                              ? "bg-brand-green/20 text-brand-green"
                              : "bg-white/[0.02] text-gray-400 hover:bg-brand-green/10 hover:text-brand-green/70"
                          } ${gated ? "cursor-not-allowed" : ""}`}
                        >
                          <span>Yes</span>
                          <span className="tabular-nums text-[11px] font-semibold text-brand-gold/90">
                            {leg.yesOdds.toFixed(2)}x
                          </span>
                        </button>
                        <div className="flex min-w-0 flex-1 items-center justify-center px-3 py-3 text-center">
                          <span className="min-w-0 text-sm text-gray-200">
                            {leg.description}
                          </span>
                        </div>
                        {hasNo && (
                          <button
                            disabled={vaultEmpty || gated}
                            onClick={() => toggleLeg(leg, 2)}
                            className={`flex w-24 flex-shrink-0 flex-col items-center justify-center gap-0.5 border-l border-white/5 px-2 py-3 text-xs font-bold uppercase tracking-wider transition-all ${
                              selected?.outcomeChoice === 2
                                ? "bg-brand-amber/20 text-brand-amber"
                                : "bg-white/[0.02] text-gray-400 hover:bg-brand-amber/10 hover:text-brand-amber/70"
                            } ${gated ? "cursor-not-allowed" : ""}`}
                          >
                            <span>No</span>
                            <span className="tabular-nums text-[11px] font-semibold text-brand-gold/90">
                              {(leg.noOdds ?? effectiveOdds(leg, 2)).toFixed(2)}x
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Ticket builder / summary panel */}
      <div className="lg:col-span-2" id="parlay-panel">
        <div className="glass-card-glow sticky top-20 max-h-[calc(100vh-6rem)] space-y-6 overflow-y-auto p-6">
          {/* Multiplier climb */}
          <div id="parlay-multiplier">
            <MultiplierClimb
              legMultipliers={selectedLegs.map((s) => effectiveOdds(s.leg, s.outcomeChoice))}
              animated
            />
          </div>

          {/* Selected legs summary with numbered badges */}
          {selectedLegs.length > 0 && (
            <div className="space-y-2">
              {selectedLegs.map((s) => (
                <div
                  key={s.leg.id.toString()}
                  className="flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2 text-sm animate-fade-in"
                >
                  <span className="min-w-0 flex-1 truncate text-gray-300">
                    {s.leg.description}
                  </span>
                  <span className="flex-shrink-0 rounded-md bg-brand-pink/15 px-2 py-0.5 font-mono text-sm font-bold text-brand-pink">
                    {effectiveOdds(s.leg, s.outcomeChoice).toFixed(2)}x
                  </span>
                  <span
                    className={`ml-2 flex-shrink-0 text-xs font-bold ${
                      s.outcomeChoice === 1 ? "text-brand-green" : "text-brand-amber"
                    }`}
                  >
                    {s.outcomeChoice === 1 ? "YES" : "NO"}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleLeg(s.leg, s.outcomeChoice)}
                    aria-label={`Remove ${s.leg.description}`}
                    className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/5 text-gray-500 transition-colors hover:bg-neon-red/20 hover:text-neon-red"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="h-3 w-3"
                    >
                      <path
                        fillRule="evenodd"
                        d="M4.28 3.22a.75.75 0 00-1.06 1.06L8.94 10l-5.72 5.72a.75.75 0 101.06 1.06L10 11.06l5.72 5.72a.75.75 0 101.06-1.06L11.06 10l5.72-5.72a.75.75 0 00-1.06-1.06L10 8.94 4.28 3.22z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Lossless toggle — swaps the source of stake from USDC to promo credit */}
          {hasAnyCredit && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                    Lossless mode
                  </p>
                  <p className="mt-0.5 text-[11px] text-amber-200/70">
                    Use promo credit (${parseFloat(formatUnits(credit!, 6)).toFixed(2)})
                    instead of USDC. Wins lock VOO; losses just burn credit.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useLossless}
                  onClick={() => {
                    resetSuccess();
                    setUseLossless((v) => !v);
                  }}
                  className={`relative h-6 w-11 flex-shrink-0 self-center rounded-full transition-colors ${
                    useLossless ? "bg-amber-500" : "bg-white/10"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                      useLossless ? "right-0.5" : "left-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>
          )}

          {/* Stake input */}
          <div id="stake-input">
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium uppercase tracking-wider text-gray-500">
                {useLossless ? "Stake (Credit)" : "Stake (USDC)"}
              </label>
              {useLossless ? (
                <span className="text-xs text-gray-500">
                  Credit: {creditNum.toFixed(2)}
                </span>
              ) : (
                usdcBalance !== undefined && (
                  <span className="flex items-center gap-2 text-xs text-gray-500">
                    Balance: {parseFloat(formatUnits(usdcBalance, 6)).toFixed(2)}
                    {isConnected && (
                      <button
                        onClick={() => mintHook.mint()}
                        disabled={mintHook.isPending || mintHook.isConfirming}
                        className="rounded-md bg-brand-pink/20 px-1.5 py-0.5 text-[10px] font-semibold text-brand-pink transition-colors hover:bg-brand-pink/30 disabled:opacity-50"
                      >
                        {mintHook.isPending ? "..." : mintHook.isConfirming ? "Minting" : mintHook.isSuccess ? "Done!" : "+ Mint"}
                      </button>
                    )}
                  </span>
                )
              )}
              {mintHook.error && (
                <p className="text-xs text-red-400">{mintHook.error}</p>
              )}
            </div>
            <div className="relative">
              <input
                type="text"
                inputMode="decimal"
                value={stake}
                onKeyDown={blockNonNumericKeys}
                onChange={(e) => { resetSuccess(); setStake(sanitizeNumericInput(e.target.value)); }}
                placeholder={`Min ${effectiveMinStake} ${useLossless ? "credit" : "USDC"}`}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 pr-24 text-lg font-semibold text-white placeholder-gray-600 outline-none transition-colors focus:border-brand-pink/50"
              />
              <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
                {useLossless && credit !== undefined && credit > 0n && (
                  <button
                    type="button"
                    onClick={() => setStake(formatUnits(credit, 6))}
                    className="rounded-md bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-300 transition-colors hover:bg-amber-500/30"
                  >
                    MAX
                  </button>
                )}
                {!useLossless && usdcBalance !== undefined && usdcBalance > 0n && (
                  <button
                    type="button"
                    onClick={() => setStake(formatUnits(usdcBalance!, 6))}
                    className="rounded-md bg-brand-pink/20 px-2 py-0.5 text-xs font-semibold text-brand-pink transition-colors hover:bg-brand-pink/30"
                  >
                    MAX
                  </button>
                )}
                <span className="text-sm text-gray-500">
                  {useLossless ? "CREDIT" : "USDC"}
                </span>
              </div>
            </div>
            {stakeNum > 0 && (
              <p className="mt-1 text-right text-xs text-gray-500">
                = ${stakeNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            )}
            {selectedLegs.length >= MIN_LEGS && statsLoaded && impliedMaxStake > 0 && (
              <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                <span>
                  Vault caps this parlay at{" "}
                  <span className="font-semibold text-gray-300">
                    ${impliedMaxStake.toFixed(2)}
                  </span>{" "}
                  stake
                </span>
                <button
                  type="button"
                  onClick={() => { resetSuccess(); setStake(impliedMaxStake.toFixed(2)); }}
                  className="rounded-md bg-white/5 px-2 py-0.5 font-semibold text-gray-300 transition-colors hover:bg-white/10"
                >
                  Use cap
                </button>
              </div>
            )}
          </div>

          {/* Payout breakdown — single multiplier + payout. Per-leg fee and
              correlation discount are baked into the multiplier and never
              surfaced on their own (CORRELATION.md spec). */}
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-gray-400">
              <span>Potential Payout</span>
              <span className="font-semibold text-white">
                ${potentialPayout.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>Combined Odds</span>
              <span className="gradient-text-gold text-glow-gold font-bold">
                {multiplier.toFixed(2)}x
              </span>
            </div>
          </div>

          {/* Kelly AI Risk Advisor UI — rendered the risk-advisor card
              (action badge, Kelly/EV/edge stats, reasoning, suggested stake,
              and collapsible 0G AI insight) whenever the parlay had enough
              legs and a positive stake. DISABLED: no longer rendered by the
              application. The corresponding state and fetch logic above is
              commented out but preserved so this UI can be re-enabled later. */}

          {/* Buy button */}
          <button
            onClick={!mounted || !isConnected ? () => openConnectModal(true) : handleBuy}
            disabled={mounted && isConnected && (!canBuy || vaultEmpty || isPending || isConfirming)}
            className={`btn-gradient w-full rounded-xl py-3.5 text-sm font-bold uppercase tracking-wider text-white transition-all ${
              !mounted || !isConnected
                ? ""
                : canBuy && !vaultEmpty && !isPending && !isConfirming
                  ? ""
                  : "!bg-none !bg-gray-800 !text-gray-500 cursor-not-allowed !shadow-none"
            }`}
          >
            {buyButtonLabel()}
          </button>

          {/* Tx feedback */}
          {txState && (
            <div
              className={`rounded-lg px-4 py-2.5 text-center text-sm font-medium animate-fade-in ${
                txState === "confirmed"
                  ? "bg-neon-green/10 text-neon-green"
                  : "bg-brand-purple/10 text-brand-purple-1"
              }`}
            >
              {txState === "pending" && "Transaction submitted..."}
              {txState === "confirming" && "Waiting for confirmation..."}
              {txState === "confirmed" && lastTicketId != null && (
                <Link href={`/ticket/${lastTicketId.toString()}`} className="underline underline-offset-2 hover:text-neon-green/80">
                  Your parlay ticket is live! View Ticket #{lastTicketId.toString()} &rarr;
                </Link>
              )}
              {txState === "confirmed" && lastTicketId == null && "Your parlay ticket is live!"}
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-neon-red/10 px-4 py-2.5 text-center text-sm text-neon-red animate-fade-in">
              {error.message.length > 100
                ? error.message.slice(0, 100) + "..."
                : error.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
