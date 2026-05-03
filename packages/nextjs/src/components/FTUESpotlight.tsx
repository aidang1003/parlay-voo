"use client";

import { useState, useEffect, useCallback, useRef, createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";

const FTUE_ROUTE = "/parlay";

// ── FTUE Hook ──────────────────────────────────────────────────────────

interface FTUEStep {
  targetId: string;
  title: string;
  description: string;
  position?: "top" | "bottom" | "left" | "right";
}

const STEPS: FTUEStep[] = [
  {
    targetId: "ftue-builder",
    title: "Place a Bet",
    description: "Pick 2-5 prediction legs from the markets and choose Yes or No on each. Your odds multiply together for a bigger payout.",
    position: "top",
  },
  {
    targetId: "ftue-vault-link",
    title: "Be the House",
    description: "Head to the Vault page to deposit USDC. You earn yield from fees and from every bet that crashes.",
    position: "bottom",
  },
];

const STORAGE_KEY = "ftue:completed";

// ── Shared Context ─────────────────────────────────────────────────────

interface FTUEState {
  active: boolean;
  stepIndex: number;
  steps: FTUEStep[];
  currentStep: FTUEStep | null;
  next: () => void;
  prev: () => void;
  skip: () => void;
  restart: () => void;
}

const FTUEContext = createContext<FTUEState | null>(null);

export function FTUEProvider({ children }: { children: ReactNode }) {
  const state = useFTUEInternal();
  return <FTUEContext.Provider value={state}>{children}</FTUEContext.Provider>;
}

export function useFTUE(): FTUEState {
  const ctx = useContext(FTUEContext);
  if (!ctx) {
    throw new Error("useFTUE must be used within <FTUEProvider>");
  }
  return ctx;
}

function useFTUEInternal(): FTUEState {
  const pathname = usePathname();
  const [running, setRunning] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  // Only activate on the parlay route. Without this gate the auto-advance
  // grace period would silently walk through every step on /onboarding (where
  // none of the targets exist) and mark the FTUE complete before the user
  // ever reaches /parlay.
  useEffect(() => {
    if (pathname !== FTUE_ROUTE) {
      setRunning(false);
      setStepIndex(0);
      setHydrated(true);
      return;
    }
    try {
      const done = sessionStorage.getItem(STORAGE_KEY) === "true";
      setRunning(!done);
      setStepIndex(0);
    } catch {
      // sessionStorage unavailable
    }
    setHydrated(true);
  }, [pathname]);

  const next = useCallback(() => {
    setStepIndex((prev) => {
      if (prev >= STEPS.length - 1) {
        try {
          sessionStorage.setItem(STORAGE_KEY, "true");
        } catch {
          // sessionStorage unavailable
        }
        setRunning(false);
        return 0;
      }
      return prev + 1;
    });
  }, []);

  const prev = useCallback(() => {
    setStepIndex((p) => Math.max(0, p - 1));
  }, []);

  const skip = useCallback(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // sessionStorage unavailable
    }
    setRunning(false);
    setStepIndex(0);
  }, []);

  const restart = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // sessionStorage unavailable
    }
    // Only start running if we're on the FTUE route. Otherwise just clear
    // storage — the pathname effect will start the tour once the user lands
    // on /parlay.
    if (pathname === FTUE_ROUTE) {
      setRunning(true);
      setStepIndex(0);
    }
  }, [pathname]);

  const active = hydrated && running;
  const currentStep = active ? STEPS[stepIndex] : null;

  return { active, stepIndex, steps: STEPS, currentStep, next, prev, skip, restart };
}

// ── Spotlight Component ────────────────────────────────────────────────

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function FTUESpotlight() {
  const { active, stepIndex, steps, currentStep, next, prev, skip } = useFTUE();
  const [rect, setRect] = useState<SpotlightRect | null>(null);
  const rafRef = useRef<number>(0);
  // Track when portal target (document.body) is available — only true on the
  // client. Without this guard, SSR would try to portal during render.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Track whether the target element exists on the current page
  const [targetExists, setTargetExists] = useState(false);

  // Measure target element position (compare before setState to avoid 60fps re-renders)
  const prevRectRef = useRef<SpotlightRect | null>(null);

  useEffect(() => {
    if (!active || !currentStep) {
      setRect(null);
      prevRectRef.current = null;
      setTargetExists(false);
      return;
    }

    const stepStart = Date.now();
    let everFound = false;
    let advanced = false;
    let frameCount = 0;
    function measure() {
      // Throttle: measure every 10th frame (~6fps) instead of every frame (60fps)
      frameCount++;
      if (frameCount % 10 !== 1) {
        rafRef.current = requestAnimationFrame(measure);
        return;
      }

      const el = document.getElementById(currentStep!.targetId);
      if (el) {
        everFound = true;
        setTargetExists(true);
        const r = el.getBoundingClientRect();
        const pad = 8;
        const top = r.top - pad;
        const left = r.left - pad;
        const width = r.width + pad * 2;
        const height = r.height + pad * 2;
        const prevRect = prevRectRef.current;
        if (!prevRect || prevRect.top !== top || prevRect.left !== left || prevRect.width !== width || prevRect.height !== height) {
          const nextRect = { top, left, width, height };
          prevRectRef.current = nextRect;
          setRect(nextRect);
        }
      } else {
        setTargetExists(false);
        prevRectRef.current = null;
        setRect(null);
        // Auto-advance after a 1.5s grace period when the target never appears.
        // Fixes the case where a step targets an element that only mounts after
        // user interaction (e.g. parlay-panel renders after a leg is selected).
        if (!everFound && !advanced && Date.now() - stepStart > 1500) {
          advanced = true;
          next();
          return;
        }
      }
      rafRef.current = requestAnimationFrame(measure);
    }

    measure();
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, currentStep, next]);

  // Don't render anything if FTUE inactive or target element not on current page
  if (!active || !currentStep) return null;
  if (!targetExists) return null;
  if (!mounted) return null; // portal target unavailable on server

  const tooltipPosition = currentStep.position ?? "bottom";

  // Portal to document.body so the tooltip + cutout escape any ancestor that
  // might be creating a stacking context (transform, filter, backdrop-filter
  // — including ConnectKit's wrappers and the layout's `relative z-10` shell).
  return createPortal(
    <>
      {/* Spotlight cutout */}
      {rect && (
        <div
          className="ftue-spotlight"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          }}
        />
      )}

      {/* Tooltip */}
      {rect && (
        <div
          data-testid="ftue-tooltip"
          className="fixed z-[10000] w-80 rounded-2xl border border-brand-pink/30 bg-gray-900/95 p-5 shadow-2xl backdrop-blur-xl"
          style={getTooltipStyle(rect, tooltipPosition)}
        >
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">{currentStep.title}</h3>
            <button
              onClick={skip}
              className="text-xs text-gray-500 transition-colors hover:text-gray-300"
            >
              Skip
            </button>
          </div>
          <p className="mb-4 text-sm text-gray-400">{currentStep.description}</p>

          {/* Progress dots */}
          <div className="mb-3 flex justify-center gap-1.5">
            {steps.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 w-1.5 rounded-full transition-all ${
                  i === stepIndex
                    ? "w-4 bg-brand-pink"
                    : i < stepIndex
                      ? "bg-brand-pink/50"
                      : "bg-gray-700"
                }`}
              />
            ))}
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between">
            <button
              onClick={prev}
              disabled={stepIndex === 0}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-400 transition-colors hover:text-white disabled:opacity-30"
            >
              Back
            </button>
            <button
              onClick={next}
              className="btn-gradient rounded-lg px-4 py-1.5 text-xs font-bold text-white"
            >
              {stepIndex === steps.length - 1 ? "Done" : "Next"}
            </button>
          </div>
        </div>
      )}

      {/* Click-to-skip overlay when spotlight not visible yet (initial render) */}
      {!rect && targetExists && (
        <div className="ftue-overlay" onClick={next} />
      )}
    </>,
    document.body,
  );
}

function getTooltipStyle(
  rect: SpotlightRect,
  position: string,
): React.CSSProperties {
  const gap = 16;
  switch (position) {
    case "top":
      return {
        bottom: `calc(100vh - ${rect.top}px + ${gap}px)`,
        left: Math.max(16, rect.left + rect.width / 2 - 160),
      };
    case "left":
      return {
        top: rect.top + rect.height / 2 - 80,
        right: `calc(100vw - ${rect.left}px + ${gap}px)`,
      };
    case "right":
      return {
        top: rect.top + rect.height / 2 - 80,
        left: rect.left + rect.width + gap,
      };
    case "bottom":
    default:
      return {
        top: rect.top + rect.height + gap,
        left: Math.max(16, rect.left + rect.width / 2 - 160),
      };
  }
}
