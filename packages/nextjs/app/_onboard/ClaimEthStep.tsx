"use client";

import { DonePill, OnboardStep } from "./OnboardStep";
import { useClaimGasEth } from "~~/lib/hooks/onboarding";

export function ClaimEthStep({ complete, active, enabled }: { complete: boolean; active: boolean; enabled: boolean }) {
  const { claim, isPending, error } = useClaimGasEth();

  const buttonLabel = isPending ? "Sending…" : "Claim test ETH";

  return (
    <OnboardStep
      index={4}
      title="Get test ETH for gas"
      description={
        <>
          Every transaction needs a tiny amount of ETH for the network fee. We&apos;ll send you enough for many txs.
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
            onClick={claim}
            disabled={!enabled || isPending}
            className="btn-gradient rounded-xl px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40 sm:px-5 sm:py-2.5 sm:text-sm"
          >
            {buttonLabel}
          </button>
        )
      }
    />
  );
}
