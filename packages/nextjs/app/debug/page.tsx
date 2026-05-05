import Link from "next/link";
import { DebugContracts } from "./_components/DebugContracts";
import { ChevronLeft } from "lucide-react";
import type { NextPage } from "next";
import { getMetadata } from "~~/utils/scaffold-eth/getMetadata";

export const metadata = getMetadata({
  title: "Contract Debugger",
  description: "Interact with deployed ParlayVoo contracts via auto-generated UI.",
});

const Debug: NextPage = () => {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href="/admin/debug"
          className="inline-flex items-center gap-1 text-xs text-gray-500 transition-colors hover:text-gray-300"
        >
          <ChevronLeft className="h-3 w-3" />
          Back to Admin
        </Link>
        <h1 className="text-3xl font-black text-white">
          Contract <span className="gradient-text">Debugger</span>
        </h1>
        <p className="text-gray-400">
          Auto-generated UI for every contract in{" "}
          <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-xs text-gray-300">deployedContracts.ts</code>
          . Reads run client-side; writes go through your connected wallet.
        </p>
      </header>

      <div className="rounded-2xl border border-white/5 bg-gray-900/30 p-2 sm:p-4">
        <DebugContracts />
      </div>
    </div>
  );
};

export default Debug;
