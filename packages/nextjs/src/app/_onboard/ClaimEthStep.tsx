"use client";

import {useOnboardingFaucet} from "@/lib/hooks/onboarding";
import {DonePill, OnboardStep} from "./OnboardStep";

export function ClaimEthStep({
  complete,
  active,
  enabled,
}: {
  complete: boolean;
  active: boolean;
  enabled: boolean;
}) {
  const {claimEth, available, canClaimEth, isPending, isConfirming, error} = useOnboardingFaucet();

  const buttonLabel = isPending
    ? "Confirm in wallet…"
    : isConfirming
      ? "Claiming…"
      : "Claim 0.005 ETH";

  return (
    <OnboardStep
      index={4}
      title="Get test ETH for gas"
      description={
        <>
          Every transaction needs a tiny amount of ETH for the network fee. We&apos;ll drip you enough for many txs.
          {!available && (
            <span className="ml-2 text-amber-300">
              (Faucet not deployed on this chain — try anvil_setBalance or contact the team.)
            </span>
          )}
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
            onClick={claimEth}
            disabled={!enabled || !available || !canClaimEth || isPending || isConfirming}
            className="btn-gradient rounded-xl px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40 sm:px-5 sm:py-2.5 sm:text-sm"
          >
            {buttonLabel}
          </button>
        )
      }
    />
  );
}
