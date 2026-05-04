"use client";

import { DonePill, OnboardStep } from "./OnboardStep";
import { useMintTestUSDC } from "~~/lib/hooks";

export function ClaimUsdcStep({ complete, active, enabled }: { complete: boolean; active: boolean; enabled: boolean }) {
  const { mint, canMint, isPending, isConfirming, error } = useMintTestUSDC();

  const buttonLabel = isPending ? "Confirm in wallet…" : isConfirming ? "Claiming…" : "Claim $10,000 USDC";

  return (
    <OnboardStep
      index={5}
      title="Get mock USDC to bet with"
      description={
        <>
          USDC is the stablecoin you&apos;ll wager. Worth nothing on testnet — refill any time.
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
            onClick={() => void mint()}
            disabled={!enabled || !canMint || isPending || isConfirming}
            className="btn-gradient rounded-xl px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40 sm:px-5 sm:py-2.5 sm:text-sm"
          >
            {buttonLabel}
          </button>
        )
      }
    />
  );
}
