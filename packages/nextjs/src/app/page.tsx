"use client";

import {useRouter} from "next/navigation";
import {useOnboardingProgress} from "@/lib/hooks";
import {setCompleted} from "@/lib/onboarding";
import {ClaimEthStep} from "./_onboard/ClaimEthStep";
import {ClaimUsdcStep} from "./_onboard/ClaimUsdcStep";
import {ConnectWalletStep} from "./_onboard/ConnectWalletStep";
import {EnterAppCTA} from "./_onboard/EnterAppCTA";
import {InstallWalletStep} from "./_onboard/InstallWalletStep";
import {SwitchNetworkStep} from "./_onboard/SwitchNetworkStep";

export default function OnboardingPage() {
  const router = useRouter();
  const progress = useOnboardingProgress();

  // Compute the first incomplete step so its action button gets visual emphasis.
  const flags = [
    progress.walletInstalled,
    progress.walletConnected,
    progress.onCorrectChain,
    progress.hasGas,
    progress.hasUsdc,
  ];
  const firstIncomplete = flags.findIndex((f) => !f);

  const skip = () => {
    setCompleted();
    router.push("/parlay");
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {progress.completed ? (
        <EnterAppCTA />
      ) : (
        <Hero />
      )}

      <div className="space-y-3">
        <InstallWalletStep
          complete={progress.hydrated && progress.walletInstalled}
          active={firstIncomplete === 0}
        />
        <ConnectWalletStep
          complete={progress.walletConnected}
          active={firstIncomplete === 1}
        />
        <SwitchNetworkStep
          complete={progress.onCorrectChain}
          active={firstIncomplete === 2}
          enabled={progress.walletConnected}
        />
        <ClaimEthStep
          complete={progress.hasGas}
          active={firstIncomplete === 3}
          enabled={progress.canEnter}
        />
        <ClaimUsdcStep
          complete={progress.hasUsdc}
          active={firstIncomplete === 4}
          enabled={progress.canEnter}
        />
      </div>

      <div className="text-center text-xs text-gray-500">
        Already set up?{" "}
        <button onClick={skip} className="underline transition-colors hover:text-gray-300">
          Skip onboarding
        </button>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="text-center">
      <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-3 py-1 text-xs font-medium text-yellow-200">
        <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
        You&apos;re on Base Sepolia — a testnet. Everything here uses fake money.
      </div>
      <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
        Welcome to <span className="gradient-text">ParlayVoo</span>
      </h1>
      <p className="mx-auto mt-3 max-w-md text-sm text-gray-400">
        Five quick steps to get a wallet ready. We&apos;ll explain each one — no crypto experience required.
      </p>
    </section>
  );
}
