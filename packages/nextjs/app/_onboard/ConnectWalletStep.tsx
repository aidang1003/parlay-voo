"use client";

import { DonePill, OnboardStep } from "./OnboardStep";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export function ConnectWalletStep({ complete, active }: { complete: boolean; active: boolean }) {
  return (
    <OnboardStep
      index={2}
      title="Connect your wallet"
      description="ParlayVoo never asks for your seed phrase. You stay in control of your funds."
      complete={complete}
      active={active}
      action={
        complete ? (
          <DonePill />
        ) : (
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <button
                onClick={openConnectModal}
                className="btn-gradient rounded-xl px-4 py-2 text-xs font-bold text-white sm:px-5 sm:py-2.5 sm:text-sm"
              >
                Connect
              </button>
            )}
          </ConnectButton.Custom>
        )
      }
    />
  );
}
