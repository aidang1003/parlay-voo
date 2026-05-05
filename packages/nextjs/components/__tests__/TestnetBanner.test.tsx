import { TestnetBanner } from "../TestnetBanner";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseIsTestnet = vi.fn(() => false);

vi.mock("~~/lib/hooks/debug", () => ({
  useIsTestnet: () => mockUseIsTestnet(),
}));

beforeEach(() => {
  mockUseIsTestnet.mockReturnValue(false);
});

describe("TestnetBanner", () => {
  it("renders nothing on non-testnet chains", () => {
    mockUseIsTestnet.mockReturnValue(false);
    const { container } = render(<TestnetBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a link to /admin/debug on testnet", () => {
    mockUseIsTestnet.mockReturnValue(true);
    render(<TestnetBanner />);
    expect(screen.getByTestId("testnet-banner")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /open debug page/i });
    expect(link).toHaveAttribute("href", "/admin/debug");
  });
});
