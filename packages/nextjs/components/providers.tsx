"use client";

import type { ReactNode } from "react";
import dynamic from "next/dynamic";

// Wagmi/RainbowKit + AI SDK touch indexedDB / localStorage at module load.
// Even though their consumers are "use client", Next.js still evaluates the
// module graph during static prerender and the offending globals blow up in
// the Node build environment. Dynamic-importing the inner module with
// ssr:false defers evaluation entirely to the client and keeps the offending
// graph out of every server bundle.
const ProvidersInner = dynamic(
  () => import("./ScaffoldEthAppWithProviders").then(m => ({ default: m.ScaffoldEthAppWithProviders })),
  { ssr: false },
);

export function Providers({ children }: { children: ReactNode }) {
  return <ProvidersInner>{children}</ProvidersInner>;
}
