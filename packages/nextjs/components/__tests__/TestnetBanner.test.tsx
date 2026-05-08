import { TestnetBanner } from "../TestnetBanner";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseIsTestnet = vi.fn(() => false);
const mockUseIsAdmin = vi.fn(() => ({ isAdmin: false, isLoading: false, unconfigured: false }));

vi.mock("~~/lib/hooks/debug", () => ({
  useIsTestnet: () => mockUseIsTestnet(),
  useIsAdmin: () => mockUseIsAdmin(),
}));

beforeEach(() => {
  mockUseIsTestnet.mockReturnValue(false);
  mockUseIsAdmin.mockReturnValue({ isAdmin: false, isLoading: false, unconfigured: false });
});

describe("TestnetBanner", () => {
  it("renders nothing on non-testnet chains", () => {
    mockUseIsTestnet.mockReturnValue(false);
    const { container } = render(<TestnetBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a link to /admin/debug for admins on testnet", () => {
    mockUseIsTestnet.mockReturnValue(true);
    mockUseIsAdmin.mockReturnValue({ isAdmin: true, isLoading: false, unconfigured: false });
    render(<TestnetBanner />);
    expect(screen.getByTestId("testnet-banner")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /open debug page/i });
    expect(link).toHaveAttribute("href", "/admin/debug");
  });

  it("hides the debug link for non-admins on testnet", () => {
    mockUseIsTestnet.mockReturnValue(true);
    mockUseIsAdmin.mockReturnValue({ isAdmin: false, isLoading: false, unconfigured: false });
    render(<TestnetBanner />);
    expect(screen.getByTestId("testnet-banner")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open debug page/i })).toBeNull();
  });
});
