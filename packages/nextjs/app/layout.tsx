import "@rainbow-me/rainbowkit/styles.css";
import "@scaffold-ui/components/styles.css";
import type { Metadata } from "next";
import { ThemeProvider } from "~~/components/ThemeProvider";
import { Providers } from "~~/components/providers";
import "~~/styles/globals.css";

export const metadata: Metadata = {
  title: "ParlayVoo - Crash-Parlay AMM on Base",
  description:
    "On-chain parlay betting with crash-style cashout. Build multi-leg tickets, ride the multiplier, or be the house.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning data-theme="parlay">
      <body className="min-h-screen bg-bg text-gray-200 antialiased">
        <ThemeProvider attribute="data-theme" defaultTheme="parlay" enableSystem={false} themes={["parlay", "light"]}>
          <Providers>{children}</Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
