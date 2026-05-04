"use client";

import { DonePill, OnboardStep } from "./OnboardStep";

const RECOMMENDED_WALLET = {
  name: "Rabby",
  url: "https://rabby.io/",
};

const ALTERNATIVES = [
  { name: "MetaMask", url: "https://metamask.io/" },
  { name: "Coinbase Wallet", url: "https://www.coinbase.com/wallet" },
];

export function InstallWalletStep({ complete, active }: { complete: boolean; active: boolean }) {
  return (
    <OnboardStep
      index={1}
      title="Install a wallet"
      description={
        <>
          A crypto wallet holds your account on Base. We recommend{" "}
          <a
            href={RECOMMENDED_WALLET.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white"
          >
            {RECOMMENDED_WALLET.name}
          </a>
          {ALTERNATIVES.map((w, i) => (
            <span key={w.name}>
              {i === 0 ? " — alternatives: " : ", "}
              <a href={w.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
                {w.name}
              </a>
            </span>
          ))}
          .
        </>
      }
      complete={complete}
      active={active}
      action={
        complete ? (
          <DonePill />
        ) : (
          <a
            href={RECOMMENDED_WALLET.url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-gradient inline-block rounded-xl px-4 py-2 text-xs font-bold text-white sm:px-5 sm:py-2.5 sm:text-sm"
          >
            Install {RECOMMENDED_WALLET.name}
          </a>
        )
      }
    />
  );
}
