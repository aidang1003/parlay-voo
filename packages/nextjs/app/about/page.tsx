import Link from "next/link";
import { ResetOnboardingButton } from "./ResetOnboardingButton";
import {
  ArrowRight,
  Brain,
  CheckCircle,
  Cpu,
  Globe,
  HandCoins,
  Layers,
  Lock,
  Repeat,
  Shield,
  Sprout,
  TrendingUp,
  Vault,
} from "lucide-react";
import { HowItWorks } from "~~/components/HowItWorks";

export default function AboutPage() {
  return (
    <div className="space-y-24">
      {/* Hero */}
      <section className="relative pt-8 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-brand-pink/20 bg-brand-pink/5 px-4 py-1.5 text-xs font-medium text-brand-pink">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-green" />
          Live on Base &middot; Trustless + On-Chain
        </div>
        <h1 className="mt-6 text-5xl font-black tracking-tight sm:text-6xl lg:text-7xl">
          <span className="gradient-text">Parlay Smarter.</span>
          <br />
          <span className="text-white">Win Bigger.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg text-gray-400">
          Pick your legs, stack the odds, and watch your multiplier climb. Cash out before a leg crashes or ride to full
          payout. Fully on-chain on Base.
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <Link href="/parlay" className="btn-gradient rounded-xl px-8 py-3.5 text-sm font-bold text-white">
            Start Building
          </Link>
          <Link
            href="/vault"
            className="rounded-xl border border-white/10 bg-white/5 px-8 py-3.5 text-sm font-semibold text-gray-300 transition-all hover:bg-white/10 hover:text-white"
          >
            Enter the Vault
          </Link>
        </div>
      </section>

      {/* How It Works */}
      <HowItWorks />

      {/* Deja Voo Flow */}
      <section className="mx-auto max-w-4xl">
        <h2 className="mb-3 text-center text-2xl font-bold text-white">
          The <span className="gradient-text">Deja Voo</span> Safety Net
        </h2>
        <p className="mx-auto mb-10 max-w-lg text-center text-sm text-gray-400">
          Lost a parlay? Deja Voo automatically routes a portion of your stake into yield-earning vault shares. Over
          time, you reclaim value.
        </p>
        <div className="grid grid-cols-5 gap-3">
          {[
            {
              icon: HandCoins,
              label: "Bet $100",
              sub: "Buy a parlay ticket",
              color: "text-brand-pink",
              bg: "from-brand-pink/10 to-transparent",
            },
            {
              icon: Repeat,
              label: "Lose",
              sub: "Leg crashes",
              color: "text-neon-red",
              bg: "from-neon-red/10 to-transparent",
            },
            {
              icon: Layers,
              label: "$90 to House",
              sub: "$10 to Deja Voo",
              color: "text-brand-purple-1",
              bg: "from-brand-purple/10 to-transparent",
            },
            {
              icon: Sprout,
              label: "Earning Yield",
              sub: "VOO locked 120d",
              color: "text-neon-green",
              bg: "from-neon-green/10 to-transparent",
            },
            {
              icon: CheckCircle,
              label: "Reclaim $10+",
              sub: "Unlock with yield",
              color: "text-brand-gold",
              bg: "from-brand-gold/10 to-transparent",
            },
          ].map((step, i) => {
            const Icon = step.icon;
            return (
              <div
                key={step.label}
                className="animate-fade-in-up text-center"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div
                  className={`glass-card mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br ${step.bg}`}
                >
                  <Icon className={`h-6 w-6 ${step.color}`} />
                </div>
                <p className="text-xs font-bold text-white">{step.label}</p>
                <p className="mt-0.5 text-[10px] text-gray-500">{step.sub}</p>
                {i < 4 && <ArrowRight className="mx-auto mt-2 h-3 w-3 text-gray-600 sm:hidden" />}
              </div>
            );
          })}
        </div>
      </section>

      {/* Feature Sections */}
      <section className="mx-auto max-w-5xl space-y-16">
        {/* Parlay System */}
        <div className="grid items-center gap-8 lg:grid-cols-2">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-brand-pink/20 bg-brand-pink/5 px-3 py-1 text-xs font-semibold text-brand-pink">
              <TrendingUp className="h-3 w-3" /> Parlay System
            </div>
            <h3 className="mb-3 text-2xl font-bold text-white">
              Crash-Parlay <span className="gradient-text">AMM</span>
            </h3>
            <p className="mb-4 text-sm leading-relaxed text-gray-400">
              The first on-chain parlay engine with Aviator-style crash mechanics. Your multiplier climbs with each
              resolved leg. Cash out early or ride the full payout. Three payout modes: Classic, Progressive, or Early
              Cashout.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Max Legs", value: "5" },
                { label: "Fee", value: "1-3.5%" },
                { label: "Payout Modes", value: "3" },
                { label: "Multiplier", value: "Up to 100x+" },
              ].map(stat => (
                <div key={stat.label} className="rounded-lg bg-white/5 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-gray-500">{stat.label}</p>
                  <p className="text-sm font-bold text-white">{stat.value}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="glass-card-glow flex items-center justify-center p-8">
            <div className="text-center">
              <div className="gradient-text-gold text-glow-gold text-5xl font-black">12.4x</div>
              <p className="mt-2 text-sm text-gray-400">Example 3-leg multiplier</p>
              <div className="mt-4 flex justify-center gap-2">
                {["2.1x", "2.5x", "2.4x"].map((m, i) => (
                  <span key={i} className="rounded-full gradient-bg px-3 py-1 text-xs font-bold text-white">
                    Leg {i + 1}: {m}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Vault System */}
        <div className="grid items-center gap-8 lg:grid-cols-2">
          <div className="order-2 lg:order-1">
            <div className="glass-card-glow flex items-center justify-center p-8">
              <div className="w-full space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-400">TVL</span>
                  <span className="font-bold text-white">$245,000</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-400">Utilization</span>
                  <span className="font-bold text-brand-pink">34.2%</span>
                </div>
                <div className="relative h-3 overflow-hidden rounded-full bg-gray-800">
                  <div className="absolute inset-y-0 left-0 w-[34%] rounded-full bg-gradient-to-r from-brand-pink to-brand-purple" />
                  <div
                    className="absolute inset-y-0 border-l-2 border-dashed border-yellow-400/50"
                    style={{ left: "80%" }}
                  />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-400">Fee Split</span>
                  <span className="font-bold text-neon-green">90/5/5</span>
                </div>
              </div>
            </div>
          </div>
          <div className="order-1 lg:order-2">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-neon-green/20 bg-neon-green/5 px-3 py-1 text-xs font-semibold text-neon-green">
              <Vault className="h-3 w-3" /> Vault System
            </div>
            <h3 className="mb-3 text-2xl font-bold text-white">
              Be the <span className="gradient-text">House</span>
            </h3>
            <p className="mb-4 text-sm leading-relaxed text-gray-400">
              Deposit USDC into the ERC-4626 vault and earn yield from parlay fees and losing bets. Lock shares for
              boosted fee multipliers. 80% utilization cap protects liquidity. Non-extractive fee routing: 90% LP / 5%
              protocol / 5% insurance.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Vault Type", value: "ERC-4626" },
                { label: "Utilization Cap", value: "80%" },
                { label: "Lock", value: "≥7 days" },
                { label: "Boost", value: "1× → 4×" },
              ].map(stat => (
                <div key={stat.label} className="rounded-lg bg-white/5 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-gray-500">{stat.label}</p>
                  <p className="text-sm font-bold text-white">{stat.value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Agent API */}
        <div className="grid items-center gap-8 lg:grid-cols-2">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-brand-purple/20 bg-brand-purple/5 px-3 py-1 text-xs font-semibold text-brand-purple-1">
              <Brain className="h-3 w-3" /> Agent-Friendly
            </div>
            <h3 className="mb-3 text-2xl font-bold text-white">
              x402 <span className="gradient-text">Agent API</span>
            </h3>
            <p className="mb-4 text-sm leading-relaxed text-gray-400">
              An x402-gated quote endpoint that returns a Kelly-sized stake recommendation, composite win probability,
              and edge for any leg set. Built so external autonomous agents can pay per call and integrate parlays
              without scraping a UI. Pricing for human users runs through the same engine but on the unmetered path.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Payment", value: "x402 / USDC" },
                { label: "Sizing", value: "Kelly criterion" },
                { label: "Output", value: "stake + win prob" },
                { label: "Caller", value: "Any agent" },
              ].map(stat => (
                <div key={stat.label} className="rounded-lg bg-white/5 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-gray-500">{stat.label}</p>
                  <p className="text-sm font-bold text-white">{stat.value}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="glass-card-glow flex items-center justify-center p-8">
            <pre className="w-full overflow-x-auto text-xs text-gray-300">
              <code>{`POST /api/premium/agent-quote
x402: 0.10 USDC

{
  "legs": [...],
  "stake": "100"
}

→ {
  "kellyFraction": 0.032,
  "winProbability": 0.62,
  "suggestedStake": "3.20",
  "reasoning": "..."
}`}</code>
            </pre>
          </div>
        </div>
      </section>

      {/* Trust / 0G Network Section */}
      <section className="mx-auto max-w-4xl">
        <h2 className="mb-3 text-center text-2xl font-bold text-white">
          Built on <span className="gradient-text">Trust</span>
        </h2>
        <p className="mx-auto mb-10 max-w-lg text-center text-sm text-gray-400">
          Fully on-chain settlement. No custodial risk. No keeper dependency. Permissionless and verifiable.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: Globe,
              title: "Base Network",
              desc: "Low fees, fast finality, L2 security",
              color: "text-brand-blue",
            },
            {
              icon: Cpu,
              title: "JIT Quote Signer",
              desc: "Odds locked at buy time, not registration",
              color: "text-brand-purple-1",
            },
            {
              icon: Shield,
              title: "Trustless Settlement",
              desc: "Permissionless, anyone can settle",
              color: "text-neon-green",
            },
            {
              icon: Lock,
              title: "Non-Extractive",
              desc: "No owner drain paths, deterministic fees",
              color: "text-brand-gold",
            },
          ].map((card, i) => {
            const Icon = card.icon;
            return (
              <div
                key={card.title}
                className="glass-card p-5 text-center animate-fade-in-up"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <Icon className={`mx-auto mb-3 h-8 w-8 ${card.color}`} />
                <h3 className="mb-1 text-sm font-bold text-white">{card.title}</h3>
                <p className="text-xs text-gray-500">{card.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Behind the scenes */}
      <section className="mx-auto max-w-3xl">
        <h2 className="mb-3 text-center text-2xl font-bold text-white">
          Behind the <span className="gradient-text">Scenes</span>
        </h2>
        <p className="mx-auto mb-8 max-w-lg text-center text-sm text-gray-400">
          Markets sync from Polymarket. A single deployer EOA submits resolutions to the on-chain admin oracle. A Vercel
          cron settles tickets once their legs resolve. Every ticket carries a builder code attribution onchain.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="glass-card p-4 text-center">
            <p className="text-[10px] uppercase tracking-wider text-gray-500">Source</p>
            <p className="mt-1 text-sm font-bold text-white">Polymarket Gamma</p>
            <p className="text-[10px] text-gray-500">Curation + odds</p>
          </div>
          <div className="glass-card p-4 text-center">
            <p className="text-[10px] uppercase tracking-wider text-gray-500">Settlement</p>
            <p className="mt-1 text-sm font-bold text-white">Vercel cron</p>
            <p className="text-[10px] text-gray-500">Permissionless on-chain</p>
          </div>
          <div className="glass-card p-4 text-center">
            <p className="text-[10px] uppercase tracking-wider text-gray-500">Builder code</p>
            <p className="mt-1 text-sm font-bold text-white">parlayvoo</p>
            <p className="text-[10px] text-gray-500">Stamped on every ticket</p>
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-gray-600">
          Source on{" "}
          <a
            href="https://github.com/aidang1003/scaffold-eth-parlay-voo"
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-pink hover:underline"
          >
            GitHub
          </a>
          .
        </p>
      </section>

      {/* Bottom CTA */}
      <section className="mx-auto max-w-2xl text-center">
        <div className="glass-card-glow p-10">
          <h2 className="text-3xl font-black text-white">
            Ready to <span className="gradient-text">Parlay</span>?
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-gray-400">
            Stack your predictions, ride the multiplier, and win big. Or provide liquidity and earn when others play.
            The choice is yours.
          </p>
          <div className="mt-6 flex items-center justify-center gap-4">
            <Link href="/parlay" className="btn-gradient rounded-xl px-8 py-3 text-sm font-bold text-white">
              Start Building
            </Link>
            <Link
              href="/vault"
              className="rounded-xl border border-white/10 bg-white/5 px-8 py-3 text-sm font-semibold text-gray-300 transition-all hover:bg-white/10 hover:text-white"
            >
              Enter the Vault
            </Link>
          </div>
          <div className="mt-6">
            <ResetOnboardingButton />
          </div>
        </div>
      </section>
    </div>
  );
}
