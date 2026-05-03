"use client";

import {useMintTestUSDC, useOnboardingFaucet} from "@/lib/hooks";
import {DonePill, OnboardStep} from "./OnboardStep";

export function ClaimUsdcStep({
  complete,
  active,
  enabled,
}: {
  complete: boolean;
  active: boolean;
  enabled: boolean;
}) {
  const faucet = useOnboardingFaucet();
  const fallbackMint = useMintTestUSDC();

  // Prefer the faucet (cooldown-enforced) when deployed; fall back to direct
  // MockUSDC mint when the faucet isn't available on this chain.
  const useFallback = !faucet.available;

  const isPending = useFallback ? fallbackMint.isPending : faucet.isPending;
  const isConfirming = useFallback ? fallbackMint.isConfirming : faucet.isConfirming;
  const error = useFallback ? fallbackMint.error : faucet.error;

  const onClick = () => {
    if (useFallback) {
      void fallbackMint.mint();
    } else {
      void faucet.claimUsdc();
    }
  };

  const buttonLabel = isPending
    ? "Confirm in wallet…"
    : isConfirming
      ? "Claiming…"
      : "Claim $10,000 USDC";

  const cooldownNote =
    !useFallback && faucet.nextUsdcClaimAt && !faucet.canClaimUsdc
      ? ` (next claim ${formatRelative(faucet.nextUsdcClaimAt)})`
      : "";

  const disabled =
    !enabled ||
    isPending ||
    isConfirming ||
    (useFallback ? !fallbackMint.canMint : !faucet.canClaimUsdc);

  return (
    <OnboardStep
      index={5}
      title="Get mock USDC to bet with"
      description={
        <>
          USDC is the stablecoin you&apos;ll wager. Worth nothing on testnet — refill any time.{cooldownNote}
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
            onClick={onClick}
            disabled={disabled}
            className="btn-gradient rounded-xl px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40 sm:px-5 sm:py-2.5 sm:text-sm"
          >
            {buttonLabel}
          </button>
        )
      }
    />
  );
}

function formatRelative(unix: number): string {
  const diffSec = unix - Math.floor(Date.now() / 1000);
  if (diffSec <= 0) return "now";
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}
