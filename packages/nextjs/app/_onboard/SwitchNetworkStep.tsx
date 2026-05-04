"use client";

import { useState } from "react";
import { DonePill, OnboardStep } from "./OnboardStep";
import { useSwitchChain } from "wagmi";
import { usePinnedChainId } from "~~/lib/hooks/_internal";
import { CHAINS, type SupportedChainId } from "~~/utils/parlay";

export function SwitchNetworkStep({
  complete,
  active,
  enabled,
}: {
  complete: boolean;
  active: boolean;
  enabled: boolean;
}) {
  const pinned = usePinnedChainId();
  const { switchChainAsync, isPending } = useSwitchChain();
  const [error, setError] = useState<string | null>(null);
  const pinnedName = CHAINS[pinned as SupportedChainId]?.name ?? `chain ${pinned}`;

  const handleSwitch = async () => {
    setError(null);
    try {
      await switchChainAsync({ chainId: pinned });
    } catch (err) {
      setError(err instanceof Error ? err.message : `Add ${pinnedName} to your wallet first.`);
    }
  };

  return (
    <OnboardStep
      index={3}
      title={`Switch to ${pinnedName}`}
      description={
        <>
          We&apos;re on a testnet — every action uses fake money. Click below to switch your wallet.
          {error && <span className="ml-2 text-red-300">({error})</span>}
        </>
      }
      complete={complete}
      active={active}
      action={
        complete ? (
          <DonePill />
        ) : (
          <button
            onClick={handleSwitch}
            disabled={!enabled || isPending}
            className="btn-gradient rounded-xl px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40 sm:px-5 sm:py-2.5 sm:text-sm"
          >
            {isPending ? "Switching…" : "Switch"}
          </button>
        )
      }
    />
  );
}
