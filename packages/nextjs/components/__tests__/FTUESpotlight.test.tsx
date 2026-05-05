import { FTUEProvider, FTUESpotlight } from "../FTUESpotlight";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FTUE only activates on /parlay (the route gate keeps it from auto-completing
// on /onboarding where its targets don't exist).
vi.mock("next/navigation", () => ({
  usePathname: () => "/parlay",
}));

// ── DOM mocks ─────────────────────────────────────────────────────────────

const fakeRect = {
  top: 100,
  left: 100,
  width: 200,
  height: 40,
  right: 300,
  bottom: 140,
  x: 100,
  y: 100,
  toJSON: () => ({}),
};
const fakeElement = { getBoundingClientRect: () => fakeRect } as unknown as HTMLElement;

// ── Session storage mock ──────────────────────────────────────────────────

let sessionStore: Record<string, string>;

beforeEach(() => {
  sessionStore = {};
  vi.stubGlobal("sessionStorage", {
    getItem: vi.fn((key: string) => sessionStore[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      sessionStore[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete sessionStore[key];
    }),
    clear: vi.fn(() => {
      sessionStore = {};
    }),
    length: 0,
    key: vi.fn(() => null),
  });
  // Mock getElementById to return a fake element for FTUE targets
  vi.spyOn(document, "getElementById").mockReturnValue(fakeElement as unknown as HTMLElement);
  // Mock requestAnimationFrame to return ID without executing (measure() is called directly first)
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("FTUESpotlight", () => {
  it("renders tooltip on first visit", async () => {
    await act(async () => {
      render(
        <FTUEProvider>
          <FTUESpotlight />
        </FTUEProvider>,
      );
    });
    expect(screen.getByTestId("ftue-tooltip")).toBeInTheDocument();
    expect(screen.getByText("Place a Bet")).toBeInTheDocument();
  });

  it("does not render when the tour is completed", async () => {
    sessionStore["ftue:completed"] = "true";
    await act(async () => {
      render(
        <FTUEProvider>
          <FTUESpotlight />
        </FTUEProvider>,
      );
    });
    expect(screen.queryByTestId("ftue-tooltip")).not.toBeInTheDocument();
  });

  it("skip button completes the tour", async () => {
    await act(async () => {
      render(
        <FTUEProvider>
          <FTUESpotlight />
        </FTUEProvider>,
      );
    });
    expect(screen.getByTestId("ftue-tooltip")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText("Skip"));
    });
    expect(screen.queryByTestId("ftue-tooltip")).not.toBeInTheDocument();
    expect(sessionStorage.setItem).toHaveBeenCalledWith("ftue:completed", "true");
  });

  it("renders progress dots", async () => {
    await act(async () => {
      render(
        <FTUEProvider>
          <FTUESpotlight />
        </FTUEProvider>,
      );
    });
    // Two-step tour: Place a Bet, Be the House.
    const tooltip = screen.getByTestId("ftue-tooltip");
    const dots = tooltip.querySelectorAll(".rounded-full");
    // Filter to just the small progress dots (h-1.5 w-1.5)
    const progressDots = Array.from(dots).filter(d => d.classList.contains("h-1\\.5") || d.className.includes("h-1.5"));
    expect(progressDots.length).toBe(2);
  });

  it("shows Back button disabled on first step", async () => {
    await act(async () => {
      render(
        <FTUEProvider>
          <FTUESpotlight />
        </FTUEProvider>,
      );
    });
    const backBtn = screen.getByText("Back");
    expect(backBtn).toBeDisabled();
  });
});
