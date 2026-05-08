"use client";

import { useEffect, useState } from "react";
import { DonePill, OnboardStep } from "./OnboardStep";

const RABBY = { name: "Rabby", url: "https://rabby.io/" };
const METAMASK = { name: "MetaMask", url: "https://metamask.io/" };
const COINBASE = { name: "Coinbase Wallet", url: "https://www.coinbase.com/wallet" };

// Rabby ships no Safari extension; MetaMask doesn't either. Coinbase Wallet has
// a Safari Web Extension on macOS and a first-party iOS app, so it's the only
// branch of these three that gives a Safari user a working install path.
function detectSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
}

export function InstallWalletStep({ complete, active }: { complete: boolean; active: boolean }) {
  const [isSafari, setIsSafari] = useState(false);
  useEffect(() => {
    setIsSafari(detectSafari());
  }, []);

  const recommended = isSafari ? COINBASE : RABBY;
  const alternatives = isSafari ? [METAMASK, RABBY] : [METAMASK, COINBASE];

  return (
    <OnboardStep
      index={1}
      title="Install a wallet"
      description={
        <>
          A crypto wallet holds your account on Base. We recommend{" "}
          <a href={recommended.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
            {recommended.name}
          </a>
          {isSafari && " (Rabby and MetaMask don't ship Safari extensions)"}
          {alternatives.map((w, i) => (
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
            href={recommended.url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-gradient inline-block rounded-xl px-4 py-2 text-xs font-bold text-white sm:px-5 sm:py-2.5 sm:text-sm"
          >
            Install {recommended.name}
          </a>
        )
      }
    />
  );
}
