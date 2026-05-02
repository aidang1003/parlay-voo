"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

// wagmi → ConnectKit → @walletconnect/core touches `indexedDB` at module
// load. Even though `providers-inner.tsx` is "use client", Next.js collects
// it into a server chunk during static-page generation and `indexedDB`
// blows up in the Node build environment. Importing the inner module via
// next/dynamic with ssr:false defers evaluation entirely to the client and
// keeps the offending graph out of every server bundle.
const ProvidersInner = dynamic(() => import("./providers-inner"), {
  ssr: false,
});

export function Providers({ children }: { children: ReactNode }) {
  return <ProvidersInner>{children}</ProvidersInner>;
}
