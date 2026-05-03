"use client";

import {ConnectKitButton} from "connectkit";
import {DonePill, OnboardStep} from "./OnboardStep";

export function ConnectWalletStep({complete, active}: {complete: boolean; active: boolean}) {
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
          <ConnectKitButton.Custom>
            {({show}) => (
              <button
                onClick={show}
                className="btn-gradient rounded-xl px-4 py-2 text-xs font-bold text-white sm:px-5 sm:py-2.5 sm:text-sm"
              >
                Connect
              </button>
            )}
          </ConnectKitButton.Custom>
        )
      }
    />
  );
}
