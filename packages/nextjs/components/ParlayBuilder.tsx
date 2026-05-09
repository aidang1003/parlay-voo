"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { MultiplierClimb } from "./MultiplierClimb";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits, parseUnits } from "viem";
import { useAccount } from "wagmi";
import {
  useBuyLosslessParlay,
  useBuyTicket,
  useCreditBalance,
  useLegDescriptions,
  useLegStatuses,
  useMintTestUSDC,
  useParlayConfig,
  useUSDCBalance,
  useVaultStats,
} from "~~/lib/hooks";
import { blockNonNumericKeys, formatEventStart, sanitizeNumericInput, useSessionState } from "~~/lib/utils";
import type { Leg, Market } from "~~/utils/parlay";
import {
  BPS,
  CORRELATION_ASYMPTOTE_BPS,
  CORRELATION_HALF_SAT_PPM,
  MAX_LEGS,
  MAX_LEGS_PER_GROUP,
  MIN_LEGS,
  MIN_STAKE_USDC,
  PPM,
  PROTOCOL_FEE_BPS,
  applyCorrelation,
  applyFee,
  ceilToCentRaw,
  computeMultiplier,
} from "~~/utils/parlay";

/** One DisplayLeg = an entire market (yes/no collapsed). noId undefined for single-sided seed markets. */
interface DisplayLeg {
  id: bigint;
  noId?: bigint;
  description: string;
  yesOdds: number;
  noOdds?: number;
  resolved: boolean;
  outcome: number;
  expiresAt: number;
  category: string;
  marketTitle: string;
  gameGroup: string;
  onChain: boolean;
  sourceRef: string;
  yesProbabilityPPM: number;
  noProbabilityPPM?: number;
  correlationGroupId: number;
  exclusionGroupId: number;
  eventStart?: number;
  polymarketSlug?: string;
  yesOutcome?: string;
  noOutcome?: string;
  marketType?: "moneyline" | "spreads" | "totals";
  line?: number;
}

interface SelectedLeg {
  leg: DisplayLeg;
  outcomeChoice: number; // 1 = yes, 2 = no
}

/** bigint-as-string for sessionStorage round-trip. */
interface StoredSelection {
  legId: string;
  outcomeChoice: number;
}

// ── Constants ─────────────────────────────────────────────────────────────

// Pills shown by default (in addition to "Featured"). Everything else hides
// behind "+ show more" until the user expands the row.
const PINNED_CATEGORIES = ["mlb"] as const;

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

function ppmToOdds(ppm: number): number {
  if (ppm <= 0) return 1;
  return 1_000_000 / ppm;
}

/** Build a Polymarket link for the leg. Falls back to the conditionId-based
 *  /market/<id> URL when the slug is missing (legacy rows). Seed markets
 *  return null and the UI renders the question without a link. */
function polymarketHref(leg: { polymarketSlug?: string; sourceRef: string }): string | null {
  if (leg.polymarketSlug) return `https://polymarket.com/event/${leg.polymarketSlug}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(leg.sourceRef)) return `https://polymarket.com/market/${leg.sourceRef}`;
  return null;
}

// "5/9/2026 5:15 PM" for the MLB game-card header. null ⇒ no suffix.
function formatGameStartSuffix(unixSec: number | undefined): string | null {
  if (unixSec == null) return null;
  const d = new Date(unixSec * 1000);
  const date = d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}

// Same-game ML+spread blocking. Polymarket's spread market puts the favorite
// at outcomes[0] (yesOutcome) and the underdog at outcomes[1] (noOutcome),
// with line < 0 for the favorite. The moneyline market uses the same team
// strings on each side. Cross-product of YES/NO between an ML leg and a
// spread leg in the same game maps to four logical outcomes:
//
//   case A: ML YES (fav) + Spread YES (fav covers)         → spread ⊂ ML  → BLOCK (redundant)
//   case B: ML NO  (dog) + Spread YES (fav covers)         → disjoint     → BLOCK (impossible)
//   case C: ML YES (fav) + Spread NO  (dog +line)          → fringe overlap (fav wins by 1) → ALLOW
//   case D: ML NO  (dog) + Spread NO  (dog +line)          → ML ⊂ spread  → BLOCK (redundant)
//
// Returns true when the (a,b) pair must be blocked; false otherwise. The
// existing same-game correlationGroupId discount continues to apply to the
// fringe-allowed cases — fine-grained per-pair correlation tuning is a
// separate (larger) change in the math layer.
function selectionConflicts(a: { leg: DisplayLeg; outcome: 1 | 2 }, b: { leg: DisplayLeg; outcome: 1 | 2 }): boolean {
  if (!a.leg.gameGroup || a.leg.gameGroup !== b.leg.gameGroup) return false;
  const ml = a.leg.marketType === "moneyline" ? a : b.leg.marketType === "moneyline" ? b : null;
  const sp = a.leg.marketType === "spreads" ? a : b.leg.marketType === "spreads" ? b : null;
  if (!ml || !sp) return false;
  const mlTeam = ml.outcome === 1 ? ml.leg.yesOutcome : ml.leg.noOutcome;
  const spFavorite = sp.leg.yesOutcome;
  if (!mlTeam || !spFavorite) return false;
  const mlPickedFavorite = mlTeam.trim().toLowerCase() === spFavorite.trim().toLowerCase();
  const spPickedYes = sp.outcome === 1;
  // Block A (mlFav, spYes), B (mlDog, spYes), D (mlDog, spNo). Allow C (mlFav, spNo).
  if (mlPickedFavorite && spPickedYes) return true;
  if (!mlPickedFavorite && spPickedYes) return true;
  if (!mlPickedFavorite && !spPickedYes) return true;
  return false;
}

// Sports markets carry a wager type (moneyline | spreads | totals) + outcomes
// + line. Compute the per-side label so the YES/NO buttons read like a real
// sportsbook: "Padres -1.5", "Over 8.5", or just "Padres" for moneyline.
// Returns null when the market is political/crypto/news (caller falls back to
// the literal Yes/No layout).
function sportsSideLabel(leg: DisplayLeg, side: 1 | 2): string | null {
  switch (leg.marketType) {
    case "moneyline":
      return (side === 1 ? leg.yesOutcome : leg.noOutcome) ?? null;
    case "spreads": {
      const team = side === 1 ? leg.yesOutcome : leg.noOutcome;
      if (leg.line == null) return team ?? null;
      const sideLine = side === 1 ? leg.line : -leg.line;
      const signed = `${sideLine > 0 ? "+" : ""}${sideLine}`;
      return team ? `${team} ${signed}` : signed;
    }
    case "totals":
      if (leg.line == null) return side === 1 ? "Over" : "Under";
      return side === 1 ? `Over ${leg.line}` : `Under ${leg.line}`;
    default:
      return null;
  }
}

/** Falls back to yes-side complement if noOdds is missing — defensive for single-sided seed markets. */
function effectiveOdds(leg: DisplayLeg, outcome: number): number {
  if (outcome === 2) {
    if (leg.noOdds !== undefined) return leg.noOdds;
    if (leg.yesOdds <= 1) return leg.yesOdds;
    return leg.yesOdds / (leg.yesOdds - 1);
  }
  return leg.yesOdds;
}

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
        eventStart: leg.eventStart,
        polymarketSlug: leg.polymarketSlug,
        yesOutcome: leg.yesOutcome,
        noOutcome: leg.noOutcome,
        marketType: leg.marketType,
        line: leg.line,
      });
    }
  }
  return legs;
}

function restoreSelections(stored: StoredSelection[], allLegs: DisplayLeg[]): SelectedLeg[] {
  const legMap = new Map(allLegs.map(l => [l.id.toString(), l]));
  const result: SelectedLeg[] = [];
  for (const s of stored) {
    const leg = legMap.get(s.legId);
    if (leg && (s.outcomeChoice === 1 || s.outcomeChoice === 2)) {
      result.push({ leg, outcomeChoice: s.outcomeChoice });
    }
  }
  return result;
}

// ── Component ────────────────────────────────────────────────────────────

export function ParlayBuilder() {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const buyHook = useBuyTicket();
  const losslessHook = useBuyLosslessParlay();
  const { credit } = useCreditBalance();
  const [useLossless, setUseLossless] = useState(false);
  const { balance: usdcBalance } = useUSDCBalance();
  const mintHook = useMintTestUSDC();
  const { freeLiquidity, maxPayout } = useVaultStats();
  const { protocolFeeBps, correlationAsymptoteBps, correlationHalfSatPpm, maxLegsPerGroup, maxLegs, minStakeUSDC } =
    useParlayConfig();

  const { buyTicket, resetSuccess, isPending, isConfirming, isSuccess, error, lastTicketId } = useLossless
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
  const [showMoreCats, setShowMoreCats] = useState(false);

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
      if (raw) storedSelections = JSON.parse(raw) as StoredSelection[];
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
        const cats = [...new Set(markets.map(m => m.category))].sort();
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

    return () => {
      cancelled = true;
    };
  }, []);

  // Reconcile selectedLegs when allLegs changes
  useEffect(() => {
    setSelectedLegs(prev => {
      if (prev.length === 0) return prev;
      const legMap = new Map(allLegs.map(l => [l.id.toString(), l]));
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
      const serialized: StoredSelection[] = selectedLegs.map(s => ({
        legId: s.leg.id.toString(),
        outcomeChoice: s.outcomeChoice,
      }));
      sessionStorage.setItem(SESSION_KEYS.legs, JSON.stringify(serialized));
    } catch {
      // storage full or unavailable
    }
  }, [mounted, selectedLegs]);

  // 30s CLOB-mid poll, paused once buy flow starts (quote-sign's final refetch becomes source of truth).
  // Also auto-pauses after 10 minutes of cart inactivity to cap DB egress for
  // idle tabs — quote-sign re-prices on submit so a stale display is harmless.
  // Any cart change re-runs this effect (selectedLegsKey dep) and starts a fresh window.
  const selectedLegsKey = useMemo(
    () => selectedLegs.map(s => `${s.leg.sourceRef}:${s.outcomeChoice}`).join("|"),
    [selectedLegs],
  );
  const buyActive = isPending || isConfirming || isSuccess;

  useEffect(() => {
    if (selectedLegs.length < 2 || buyActive) return;

    const STALE_AFTER_MS = 10 * 60 * 1000;
    const startedAt = Date.now();
    const abort = new AbortController();
    let cancelled = false;

    async function refresh() {
      if (cancelled) return;
      try {
        const res = await fetch("/api/quote-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            legs: selectedLegs.map(s => ({
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
        const freshBySource = new Map<string, number>(data.legs.map(l => [l.sourceRef, l.probabilityPPM]));

        setAllLegs(prev => {
          let changed = false;
          const next = prev.map(leg => {
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
    const id = window.setInterval(() => {
      if (Date.now() - startedAt > STALE_AFTER_MS) {
        clearInterval(id);
        return;
      }
      refresh();
    }, 30_000);
    return () => {
      cancelled = true;
      abort.abort();
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLegsKey, buyActive]);

  // ── Derived values ─────────────────────────────────────────────────────

  const stakeNum = parseFloat(stake) || 0;
  const effectiveMaxLegs = maxLegs ?? MAX_LEGS;
  const effectiveMinStake = minStakeUSDC ?? MIN_STAKE_USDC;
  const effectiveProtocolFee = protocolFeeBps ?? PROTOCOL_FEE_BPS;
  const netLegFactor = (BPS - effectiveProtocolFee) / BPS;
  const effectiveCorrAsymptote = correlationAsymptoteBps ?? CORRELATION_ASYMPTOTE_BPS;
  const effectiveCorrHalfSat = correlationHalfSatPpm ?? CORRELATION_HALF_SAT_PPM;
  const effectiveMaxLegsPerGroup = maxLegsPerGroup ?? MAX_LEGS_PER_GROUP;

  // skip synthetic (negative) ids — markets.ts uses them for not-yet-JIT-registered rows
  const onChainLegIds = useMemo(() => allLegs.map(l => l.id).filter(id => id >= 0n), [allLegs]);
  const builderLegMap = useLegDescriptions(onChainLegIds);
  const builderLegStatuses = useLegStatuses(onChainLegIds, builderLegMap, 30_000);

  // drop oracle-resolved legs; buying them would revert at quote-sign
  const liveLegs = useMemo(() => {
    if (builderLegStatuses.size === 0) return allLegs;
    return allLegs.filter(l => {
      if (l.id < 0n) return true;
      const status = builderLegStatuses.get(l.id.toString());
      return !status?.resolved;
    });
  }, [allLegs, builderLegStatuses]);

  const filteredLegs = useMemo(() => {
    if (activeCategory === "all") return liveLegs;
    return liveLegs.filter(l => l.category === activeCategory);
  }, [liveLegs, activeCategory]);

  useEffect(() => {
    if (activeCategory !== "all" && allLegs.length > 0 && filteredLegs.length === 0) {
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

    // Order games by earliest first-pitch / tip-off so a same-matchup series
    // reads chronologically (May 9 before May 10). Games with no eventStart
    // (political markets, season-long props, missing data) sink to the end.
    const earliestStart = (g: (typeof games)[number]): number => {
      let min = Infinity;
      for (const market of g.markets) {
        for (const leg of market.legs) {
          if (leg.eventStart != null && leg.eventStart < min) min = leg.eventStart;
        }
      }
      return min;
    };
    games.sort((a, b) => earliestStart(a) - earliestStart(b));
    return games;
  }, [filteredLegs]);

  const multiplier = useMemo(() => {
    if (selectedLegs.length === 0) return 1;
    const probs = selectedLegs.map(s =>
      s.outcomeChoice === 2 ? (s.leg.noProbabilityPPM ?? PPM - s.leg.yesProbabilityPPM) : s.leg.yesProbabilityPPM,
    );
    if (probs.some(p => p <= 0 || p >= PPM)) {
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
    const finalMul = applyCorrelation(feeAdjusted, groupSizes, effectiveCorrAsymptote, effectiveCorrHalfSat);
    return Number(finalMul) / PPM;
  }, [selectedLegs, effectiveProtocolFee, effectiveCorrAsymptote, effectiveCorrHalfSat]);

  const potentialPayout = stakeNum * multiplier;

  // distribute fee+correlation discount evenly so the chart's last point matches the headline multiplier
  const climbLegMultipliers = useMemo(() => {
    if (selectedLegs.length === 0) return [];
    const raw = selectedLegs.map(s => effectiveOdds(s.leg, s.outcomeChoice));
    const rawProduct = raw.reduce((acc, m) => acc * m, 1);
    if (!Number.isFinite(rawProduct) || rawProduct <= 0 || multiplier <= 0) return raw;
    const scale = Math.pow(multiplier / rawProduct, 1 / raw.length);
    return raw.map(m => m * scale);
  }, [selectedLegs, multiplier]);

  // round approval up to next $0.01 so sub-cent drift can't starve safeTransferFrom; lossless skips
  const paymentAmountUsdc = useMemo(() => {
    if (stakeNum <= 0 || useLossless) return stakeNum;
    try {
      const raw = parseUnits(stake || "0", 6);
      return Number(ceilToCentRaw(raw)) / 1e6;
    } catch {
      return stakeNum;
    }
  }, [stake, stakeNum, useLossless]);

  // legId → disabled reason; copy stays neutral per docs/changes/B_SLOG_SPRINT.md
  // Per-side gating. Each leg has independent yes/no entries because some
  // conflicts only block one direction (e.g. Mets ML YES blocks Mets -1.5
  // YES but leaves Mets -1.5 NO selectable — see selectionConflicts above).
  // Leg-level gates (exclusion groups, group cap) populate both sides.
  type SideGate = { reason: "conflict" | "groupCap"; conflictsWith?: string };
  const legGate = useMemo(() => {
    const gate = new Map<string, { yes?: SideGate; no?: SideGate }>();
    if (selectedLegs.length === 0) return gate;
    const setSide = (legId: string, side: "yes" | "no", entry: SideGate) => {
      const cur = gate.get(legId) ?? {};
      cur[side] = entry;
      gate.set(legId, cur);
    };
    const setBoth = (legId: string, entry: SideGate) => {
      setSide(legId, "yes", entry);
      setSide(legId, "no", entry);
    };

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
      const selfSelected = selectedLegs.find(s => s.leg.id === leg.id);

      // Exclusion group: blocks the whole leg regardless of side.
      if (!selfSelected && leg.exclusionGroupId !== 0) {
        const owner = exclusionOwners.get(leg.exclusionGroupId);
        if (owner) {
          setBoth(idKey, { reason: "conflict", conflictsWith: owner.description });
          continue;
        }
      }
      // Group cap: also whole-leg.
      if (!selfSelected && leg.correlationGroupId !== 0) {
        const count = corrCounts.get(leg.correlationGroupId) ?? 0;
        if (count >= effectiveMaxLegsPerGroup) {
          setBoth(idKey, { reason: "groupCap" });
          continue;
        }
      }
      // Per-side conflict (ML+spread same game). Evaluate each side
      // independently: if picking this side would conflict with any other
      // currently-selected leg, gate it. Skip the side that's currently
      // selected on this leg (the user can deselect it by clicking again).
      const others = selectedLegs.filter(s => s.leg.id !== leg.id);
      for (const outcome of [1, 2] as const) {
        if (selfSelected?.outcomeChoice === outcome) continue;
        for (const o of others) {
          if (selectionConflicts({ leg, outcome }, { leg: o.leg, outcome: o.outcomeChoice as 1 | 2 })) {
            setSide(idKey, outcome === 1 ? "yes" : "no", {
              reason: "conflict",
              conflictsWith: o.leg.description,
            });
            break;
          }
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

  // cap stake to avoid post-approve revert on maxPayout() / freeLiquidity()
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
      setSelectedLegs(prev => {
        const existing = prev.findIndex(s => s.leg.id === leg.id);
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
    [resetSuccess, effectiveMaxLegs],
  );

  const handleBuy = async () => {
    if (!canBuy) return;
    const quoteLegs = selectedLegs.map(s => ({
      sourceRef: s.leg.sourceRef,
      side: (s.outcomeChoice === 2 ? "no" : "yes") as "yes" | "no",
    }));
    const success = await buyTicket(quoteLegs, stakeNum);
    if (success) {
      setSelectedLegs([]);
      setStake("");
    }
  };

  // ── Derived display ────────────────────────────────────────────────────

  const txState = isPending ? "pending" : isConfirming ? "confirming" : isSuccess ? "confirmed" : null;

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

        {/* Category filter pills. Pinned categories (Featured + MLB) always
            show; the rest collapse behind "+ show more" until the user
            expands. If the active category lives in the hidden set, surface
            it inline so the active state stays visible. */}
        {(() => {
          const pinnedSet = new Set<string>(PINNED_CATEGORIES);
          const pinned = availableCategories.filter(c => pinnedSet.has(c));
          const rest = availableCategories.filter(c => !pinnedSet.has(c));
          const inlineActive =
            !showMoreCats && activeCategory !== "all" && rest.includes(activeCategory) ? [activeCategory] : [];
          const visibleCats = showMoreCats ? [...pinned, ...rest] : [...pinned, ...inlineActive];
          const hasMore = rest.length > 0;
          return (
            <div className="flex flex-wrap items-center gap-2">
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
              {visibleCats.map(cat => (
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
                  {cat === "mlb" && (
                    <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-neon-green/15 px-1.5 py-0.5 text-[10px] font-bold text-neon-green">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neon-green" />
                      LIVE
                    </span>
                  )}
                </button>
              ))}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => setShowMoreCats(s => !s)}
                  className="ml-1 text-xs font-medium text-gray-500 transition-colors hover:text-gray-200"
                >
                  {showMoreCats ? "− show less" : "+ show more"}
                </button>
              )}
            </div>
          );
        })()}

        {/* Leg counter: visual dot indicators */}
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-gray-300">Pick Your Legs</h2>
          <div className="flex gap-1">
            {Array.from({ length: effectiveMaxLegs }, (_, i) => (
              <div
                key={i}
                className={`flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold transition-all ${
                  i < selectedLegs.length ? "gradient-bg text-white shadow-sm" : "bg-white/5 text-gray-600"
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
          {groupedByGame.map(game => {
            // MLB tab gets a specialized game-card layout: each game collapses
            // its markets into a single glass-card with a prominent header
            // (matchup, first pitch, market count). Other tabs keep the flat
            // list for now — proof-of-concept before rolling to NBA/NFL/NHL.
            const mlbCard = activeCategory === "mlb" && !!game.gameGroup;
            const firstLeg = game.markets.flatMap(m => m.legs).find(l => l.eventStart !== undefined);
            const headerSuffix = formatGameStartSuffix(firstLeg?.eventStart);
            const marketCount = game.markets.length;
            const wrapperClass = mlbCard ? "glass-card space-y-3 p-4" : "space-y-3";
            // LIVE = game has started but the leg's cutoff is still in the
            // future. The cutoff for sports legs is now `gameStart + 7d`, so
            // this fires from first pitch through the post-game window until
            // either Polymarket flips closed=true (markPolyClosed) or the
            // price-based filter hides the row.
            const nowSec = Math.floor(Date.now() / 1000);
            const isLive = firstLeg?.eventStart != null && firstLeg.eventStart <= nowSec && firstLeg.expiresAt > nowSec;
            // Game-header click-through to Polymarket: every leg in a game shares
            // the same parent event slug, so any one of them is a valid source.
            const anyLeg = game.markets.flatMap(m => m.legs)[0];
            const gameHref = anyLeg ? polymarketHref(anyLeg) : null;
            return (
              <div key={`game:${game.gameGroup || "__flat__"}`} className={wrapperClass}>
                {game.gameGroup &&
                  (mlbCard ? (
                    <div className="flex items-baseline justify-between border-b border-white/5 pb-2">
                      <h2 className="text-base font-bold text-white">
                        {gameHref ? (
                          <a
                            href={gameHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open game on Polymarket"
                            className="transition-colors hover:text-brand-pink"
                          >
                            {game.gameGroup}
                          </a>
                        ) : (
                          game.gameGroup
                        )}
                        {headerSuffix && <span className="font-normal text-gray-400"> - {headerSuffix}</span>}
                        {isLive && (
                          <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-neon-green/15 px-1.5 py-0.5 align-middle text-[10px] font-bold text-neon-green">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neon-green" />
                            LIVE
                          </span>
                        )}
                      </h2>
                      <div className="flex items-center gap-3 text-[11px] text-gray-400">
                        <span>
                          {marketCount} {marketCount === 1 ? "market" : "markets"}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <h2 className="border-b border-white/5 pb-1 text-sm font-bold text-gray-300">
                      {gameHref ? (
                        <a
                          href={gameHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open game on Polymarket"
                          className="transition-colors hover:text-white"
                        >
                          {game.gameGroup}
                        </a>
                      ) : (
                        game.gameGroup
                      )}
                      {headerSuffix && <span className="ml-2 font-normal text-gray-500"> - {headerSuffix}</span>}
                      {isLive && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-neon-green/15 px-1.5 py-0.5 align-middle text-[10px] font-bold text-neon-green">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neon-green" />
                          LIVE
                        </span>
                      )}
                    </h2>
                  ))}
                {game.markets.map(({ title, legs }) => {
                  // Hide the small uppercase bucket header when it would
                  // duplicate what the leg card already says: either the
                  // single leg's description matches the title (political
                  // single-leg markets), or the leg is a sports wager whose
                  // type is rendered as the middle-of-card label.
                  const titleRedundant =
                    legs.length === 1 &&
                    (legs[0].description.trim() === title.trim() || legs[0].marketType !== undefined);
                  return (
                    <div key={`${game.gameGroup}::${title}`} className="space-y-2">
                      <div className="flex items-center gap-2">
                        {!titleRedundant && (
                          <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500">{title}</h3>
                        )}
                        {legs[0] && (
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                              CATEGORY_COLORS[legs[0].category] ?? "bg-white/10 text-gray-400 border-white/10"
                            }`}
                          >
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
                        {legs[0]?.eventStart !== undefined && (
                          <span
                            title={new Date(legs[0].eventStart * 1000).toLocaleString()}
                            className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-gray-400"
                          >
                            {formatEventStart(legs[0].eventStart)}
                          </span>
                        )}
                      </div>
                      <div className="space-y-2">
                        {legs.map((leg, legIdx) => {
                          const selected = selectedLegs.find(s => s.leg.id === leg.id);
                          const hasNo = leg.noId !== undefined;
                          const gateInfo = legGate.get(leg.id.toString());
                          // Per-side gating. A side is gated if there's an
                          // entry for it AND the user isn't already on that
                          // side (so they can deselect by clicking again).
                          const gateYes = gateInfo?.yes && selected?.outcomeChoice !== 1 ? gateInfo.yes : undefined;
                          const gateNo = gateInfo?.no && selected?.outcomeChoice !== 2 ? gateInfo.no : undefined;
                          const gatedYes = gateYes !== undefined;
                          const gatedNo = gateNo !== undefined;
                          // Whole-leg gating only when both sides are gated
                          // and nothing is selected (used for card grayout +
                          // outer tooltip).
                          const fullyGated = !selected && gatedYes && gatedNo;
                          const tooltipFor = (g: SideGate | undefined) =>
                            g
                              ? g.reason === "conflict"
                                ? `Conflicts with: ${g.conflictsWith ?? ""}`
                                : "Leg limit reached"
                              : undefined;
                          const yesTooltip = tooltipFor(gateYes);
                          const noTooltip = tooltipFor(gateNo);
                          // Sports markets read like a sportsbook: each side's
                          // button carries the wager label (Padres -1.5,
                          // Over 8.5) and the redundant question body in the
                          // middle collapses into a small Polymarket link.
                          const yesSportsLabel = sportsSideLabel(leg, 1);
                          const noSportsLabel = sportsSideLabel(leg, 2);
                          const isSports = yesSportsLabel !== null;
                          return (
                            <div
                              key={leg.id.toString()}
                              id={legIdx === 0 ? "ftue-market-card" : undefined}
                              title={fullyGated ? (yesTooltip ?? noTooltip) : undefined}
                              className={`animate-market-card-enter glass-card overflow-hidden transition-all ${
                                selected
                                  ? selected.outcomeChoice === 1
                                    ? "border-brand-green/40 shadow-[0_0_15px_rgba(34,197,94,0.1)]"
                                    : "border-brand-amber/40 shadow-[0_0_15px_rgba(245,158,11,0.1)]"
                                  : fullyGated
                                    ? "opacity-40 grayscale"
                                    : "hover:border-white/10"
                              }`}
                              style={{ animationDelay: `${legIdx * 50}ms` }}
                            >
                              {/* Yes / Question / No — question centered, sides flanking */}
                              <div className="flex items-stretch">
                                <button
                                  disabled={vaultEmpty || gatedYes}
                                  onClick={() => toggleLeg(leg, 1)}
                                  title={yesTooltip}
                                  className={`flex ${isSports ? "w-36" : "w-24"} flex-shrink-0 flex-col items-center justify-center gap-0.5 px-2 py-3 text-xs font-bold uppercase tracking-wider transition-all ${
                                    selected?.outcomeChoice === 1
                                      ? "bg-brand-green/20 text-brand-green"
                                      : gatedYes
                                        ? "cursor-not-allowed bg-white/[0.02] text-gray-600 opacity-40"
                                        : "bg-white/[0.02] text-gray-400 hover:bg-brand-green/10 hover:text-brand-green/70"
                                  }`}
                                >
                                  {yesSportsLabel ? (
                                    <span className="max-w-full text-balance text-[13px] font-semibold normal-case leading-tight tracking-normal">
                                      {yesSportsLabel}
                                    </span>
                                  ) : (
                                    <>
                                      <span>Yes</span>
                                      {leg.yesOutcome && (
                                        <span className="max-w-full truncate text-[10px] font-medium normal-case tracking-normal text-current/80">
                                          {leg.yesOutcome}
                                        </span>
                                      )}
                                    </>
                                  )}
                                  <span
                                    className={`tabular-nums font-semibold text-brand-gold/90 ${isSports ? "text-[13px]" : "text-[11px]"}`}
                                  >
                                    {(leg.yesOdds * netLegFactor).toFixed(2)}x
                                  </span>
                                </button>
                                <div className="flex min-w-0 flex-1 items-center justify-center px-3 py-3 text-center">
                                  {isSports ? (
                                    // Wager type the user is actually placing
                                    // (Moneyline / Run Line -1.5 / Over/Under
                                    // 8.5). Linked to Polymarket — same link
                                    // is also on the game-header above and in
                                    // the bet slip; the redundancy is on
                                    // purpose so the user can click out from
                                    // wherever their eye lands.
                                    polymarketHref(leg) ? (
                                      <a
                                        href={polymarketHref(leg) ?? undefined}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={e => e.stopPropagation()}
                                        title="Open on Polymarket"
                                        className="text-sm font-semibold text-gray-200 transition-colors hover:text-brand-pink"
                                      >
                                        {leg.marketTitle}
                                      </a>
                                    ) : (
                                      <span className="text-sm font-semibold text-gray-200">{leg.marketTitle}</span>
                                    )
                                  ) : polymarketHref(leg) ? (
                                    <a
                                      href={polymarketHref(leg) ?? undefined}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={e => e.stopPropagation()}
                                      title="Open on Polymarket"
                                      className="min-w-0 text-sm text-gray-200 underline decoration-gray-600 decoration-dotted underline-offset-4 transition-colors hover:text-white hover:decoration-brand-pink"
                                    >
                                      {leg.description}
                                    </a>
                                  ) : (
                                    <span className="min-w-0 text-sm text-gray-200">{leg.description}</span>
                                  )}
                                </div>
                                {hasNo && (
                                  <button
                                    disabled={vaultEmpty || gatedNo}
                                    onClick={() => toggleLeg(leg, 2)}
                                    title={noTooltip}
                                    className={`flex ${isSports ? "w-36" : "w-24"} flex-shrink-0 flex-col items-center justify-center gap-0.5 border-l border-white/5 px-2 py-3 text-xs font-bold uppercase tracking-wider transition-all ${
                                      selected?.outcomeChoice === 2
                                        ? "bg-brand-amber/20 text-brand-amber"
                                        : gatedNo
                                          ? "cursor-not-allowed bg-white/[0.02] text-gray-600 opacity-40"
                                          : "bg-white/[0.02] text-gray-400 hover:bg-brand-amber/10 hover:text-brand-amber/70"
                                    }`}
                                  >
                                    {noSportsLabel ? (
                                      <span className="max-w-full text-balance text-[13px] font-semibold normal-case leading-tight tracking-normal">
                                        {noSportsLabel}
                                      </span>
                                    ) : (
                                      <>
                                        <span>No</span>
                                        {leg.noOutcome && (
                                          <span className="max-w-full truncate text-[10px] font-medium normal-case tracking-normal text-current/80">
                                            {leg.noOutcome}
                                          </span>
                                        )}
                                      </>
                                    )}
                                    <span
                                      className={`tabular-nums font-semibold text-brand-gold/90 ${isSports ? "text-[13px]" : "text-[11px]"}`}
                                    >
                                      {((leg.noOdds ?? effectiveOdds(leg, 2)) * netLegFactor).toFixed(2)}x
                                    </span>
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Ticket builder / summary panel */}
      <div className="lg:col-span-2">
        <div
          id="parlay-panel"
          className="glass-card-glow sticky top-20 max-h-[calc(100vh-6rem)] space-y-6 overflow-y-auto p-6"
        >
          {/* Multiplier climb */}
          <div id="parlay-multiplier">
            <MultiplierClimb legMultipliers={climbLegMultipliers} animated />
            {selectedLegs.length === 0 && (
              <p className="mt-3 text-center text-xs text-gray-500">
                Pick 2 to 5 markets on the left to build your parlay.
              </p>
            )}
          </div>

          {/* Selected legs summary with numbered badges */}
          {selectedLegs.length > 0 && (
            <div className="space-y-2">
              {selectedLegs.map(s => {
                const startLabel = formatEventStart(s.leg.eventStart);
                const slipHref = polymarketHref(s.leg);
                return (
                  <div
                    key={s.leg.id.toString()}
                    className="flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2 text-sm animate-fade-in"
                  >
                    <div className="min-w-0 flex-1">
                      {slipHref ? (
                        <a
                          href={slipHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open on Polymarket"
                          className="block truncate text-gray-300 underline decoration-gray-700 decoration-dotted underline-offset-4 transition-colors hover:text-white hover:decoration-brand-pink"
                        >
                          {s.leg.description}
                        </a>
                      ) : (
                        <p className="truncate text-gray-300">{s.leg.description}</p>
                      )}
                      {startLabel && (
                        <p
                          title={s.leg.eventStart ? new Date(s.leg.eventStart * 1000).toLocaleString() : undefined}
                          className="truncate text-[10px] text-gray-500"
                        >
                          {startLabel}
                        </p>
                      )}
                    </div>
                    <span className="flex-shrink-0 rounded-md bg-brand-pink/15 px-2 py-0.5 font-mono text-sm font-bold text-brand-pink">
                      {(effectiveOdds(s.leg, s.outcomeChoice) * netLegFactor).toFixed(2)}x
                    </span>
                    <span
                      className={`ml-2 flex-shrink-0 text-xs font-bold ${
                        s.outcomeChoice === 1 ? "text-brand-green" : "text-brand-amber"
                      }`}
                    >
                      {sportsSideLabel(s.leg, s.outcomeChoice === 1 ? 1 : 2) ?? (s.outcomeChoice === 1 ? "YES" : "NO")}
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
                );
              })}
            </div>
          )}

          {/* Lossless toggle — swaps the source of stake from USDC to promo credit */}
          {hasAnyCredit && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-amber-300">Lossless mode</p>
                  <p className="mt-0.5 text-[11px] text-amber-200/70">
                    Use promo credit (${parseFloat(formatUnits(credit!, 6)).toFixed(2)}) instead of USDC. Wins lock VOO;
                    losses just burn credit.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useLossless}
                  onClick={() => {
                    resetSuccess();
                    setUseLossless(v => !v);
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
                <span className="text-xs text-gray-500">Credit: {creditNum.toFixed(2)}</span>
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
                        {mintHook.isPending
                          ? "..."
                          : mintHook.isConfirming
                            ? "Minting"
                            : mintHook.isSuccess
                              ? "Done!"
                              : "+ Mint"}
                      </button>
                    )}
                  </span>
                )
              )}
              {mintHook.error && <p className="text-xs text-red-400">{mintHook.error}</p>}
            </div>
            <div className="relative">
              <input
                type="text"
                inputMode="decimal"
                value={stake}
                onKeyDown={blockNonNumericKeys}
                onChange={e => {
                  resetSuccess();
                  setStake(sanitizeNumericInput(e.target.value));
                }}
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
                <span className="text-sm text-gray-500">{useLossless ? "CREDIT" : "USDC"}</span>
              </div>
            </div>
            {stakeNum > 0 && (
              <p className="mt-1 text-right text-xs text-gray-500">
                {useLossless ? "= " : "Payment: "}$
                {paymentAmountUsdc.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            )}
            {selectedLegs.length >= MIN_LEGS && statsLoaded && impliedMaxStake > 0 && (
              <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                <span>
                  Vault caps this parlay at{" "}
                  <span className="font-semibold text-gray-300">${impliedMaxStake.toFixed(2)}</span> stake
                </span>
                <button
                  type="button"
                  onClick={() => {
                    resetSuccess();
                    setStake(impliedMaxStake.toFixed(2));
                  }}
                  className="rounded-md bg-white/5 px-2 py-0.5 font-semibold text-gray-300 transition-colors hover:bg-white/10"
                >
                  Use cap
                </button>
              </div>
            )}
          </div>

          {/* fee + correlation baked into multiplier per docs/changes/B_SLOG_SPRINT.md */}
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-gray-400">
              <span>Potential Payout</span>
              <span className="font-semibold text-white">${potentialPayout.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>Combined Odds</span>
              <span className="gradient-text-gold text-glow-gold font-bold">{multiplier.toFixed(2)}x</span>
            </div>
          </div>

          {/* Buy button */}
          <button
            onClick={!mounted || !isConnected ? () => openConnectModal?.() : handleBuy}
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
                txState === "confirmed" ? "bg-neon-green/10 text-neon-green" : "bg-brand-purple/10 text-brand-purple-1"
              }`}
            >
              {txState === "pending" && "Transaction submitted..."}
              {txState === "confirming" && "Waiting for confirmation..."}
              {txState === "confirmed" && lastTicketId != null && (
                <Link
                  href={`/ticket/${lastTicketId.toString()}`}
                  className="underline underline-offset-2 hover:text-neon-green/80"
                >
                  Your parlay ticket is live! View Ticket #{lastTicketId.toString()} &rarr;
                </Link>
              )}
              {txState === "confirmed" && lastTicketId == null && "Your parlay ticket is live!"}
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-neon-red/10 px-4 py-2.5 text-center text-sm text-neon-red animate-fade-in">
              {error.message.length > 100 ? error.message.slice(0, 100) + "..." : error.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
