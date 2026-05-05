"use client";

import { useReadContract } from "wagmi";
import { useAccount } from "wagmi";
import {
  LockTier,
  useCreditBalance,
  useLockPositions,
  useLockStats,
  useUSDCBalance,
  useVaultPosition,
} from "~~/lib/hooks";
import { useDeployedContract } from "~~/lib/hooks/useDeployedContract";
import { formatUSDC as fmtUSDCShared } from "~~/lib/utils";

const formatUSDC = (amount: bigint | undefined) => fmtUSDCShared(amount, { locale: true });

interface Props {
  variant: "pill" | "full";
}

/**
 * Personal vault summary, used in two places: a compact pill in the header
 * and the full body of the My Position tab on /vault. Pulls from the same
 * hooks the vault dashboard reads — adding it here doesn't double the RPC
 * load because wagmi de-dupes the read calls by (address, abi, args).
 */
export function MyPositionPanel({ variant }: Props) {
  const { isConnected } = useAccount();
  const { balance: usdcBalance } = useUSDCBalance();
  const { shares: userShares, assets: userSharesValue } = useVaultPosition();
  const { positions, userTotalLocked } = useLockPositions();
  const { pendingRewards } = useLockStats();
  const { credit } = useCreditBalance();
  const vault = useDeployedContract("HouseVault");

  const { data: lockedValue } = useReadContract({
    address: vault?.address,
    abi: vault?.abi,
    functionName: "convertToAssets",
    args: userTotalLocked > 0n ? [userTotalLocked] : undefined,
    query: { enabled: !!vault && userTotalLocked > 0n, refetchInterval: 10_000 },
  });
  const lockedValueBigInt = (lockedValue as bigint | undefined) ?? 0n;

  const totalPositionValue = userSharesValue + lockedValueBigInt;
  const creditBigInt = credit ?? 0n;
  const usdcBigInt = usdcBalance ?? 0n;
  const pendingBigInt = pendingRewards ?? 0n;

  const fullPositions = positions.filter(p => p.position.tier === LockTier.FULL);
  const partialPositions = positions.filter(p => p.position.tier === LockTier.PARTIAL);
  const leastPositions = positions.filter(p => p.position.tier === LockTier.LEAST);
  const fullShares = fullPositions.reduce((s, p) => s + p.position.shares, 0n);
  const partialShares = partialPositions.reduce((s, p) => s + p.position.shares, 0n);
  const leastShares = leastPositions.reduce((s, p) => s + p.position.shares, 0n);

  if (variant === "pill") {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Tile label="Wallet USDC" value={`$${formatUSDC(usdcBigInt)}`} accent="pink" />
        <Tile label="Vault value" value={`$${formatUSDC(totalPositionValue)}`} accent="purple" />
        <Tile label="Pending rewards" value={`$${formatUSDC(pendingBigInt)}`} accent="green" />
        {creditBigInt > 0n && <Tile label="Lossless credit" value={`$${formatUSDC(creditBigInt)}`} accent="green" />}
        {!isConnected && (
          <p className="col-span-full text-center text-xs text-gray-500">Connect your wallet to see your position.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Wallet USDC" value={`$${formatUSDC(usdcBigInt)}`} accent="pink" />
        <StatCard label="Pending fee rewards" value={`$${formatUSDC(pendingBigInt)}`} accent="green" />
        <StatCard label="Lossless credit" value={`$${formatUSDC(creditBigInt)}`} accent="gold" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <PositionBox
          label="Vault VOO"
          primary={`${formatUSDC(userShares)} VOO`}
          secondary={`$${formatUSDC(userSharesValue)} value`}
          accent="white"
          tooltip={{
            title: "Liquid vault shares",
            body: "Unlocked VOO. Withdrawable any time, subject to free liquidity. No fee-share boost — lock to earn.",
          }}
        />
        <PositionBox
          label="Lossless credit"
          primary={`$${formatUSDC(creditBigInt)}`}
          secondary="spend via lossless mode"
          accent="green"
          tooltip={{
            title: "Bet-only credit",
            body: "Issued when you lose a parlay — equal to 12 months of projected yield on your now-Least-locked stake. Spend it on lossless tickets; if it expires unspent, the locked principal reverts to LPs.",
          }}
        />
      </div>

      <div className="glass-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-medium uppercase tracking-wider text-gray-500">Lock Hierarchy</h3>
          <span className="text-[11px] text-gray-600">hover for details</span>
        </div>

        <div className="space-y-2">
          <TierRow
            label="Full"
            tier="full"
            shares={fullShares}
            positionCount={fullPositions.length}
            tooltip={{
              title: "Full lock — top tier",
              body: "Time-locked VOO earning a fee-share boost. Curve: 1× at 7 days, 2× at 1 year, asymptotic 4× ceiling. Earnings stream into Pending Fee Rewards (above).",
            }}
          />
          <Connector />
          <TierRow
            label="Partial"
            tier="partial"
            shares={partialShares}
            positionCount={partialPositions.length}
            tooltip={{
              title: "Partial — credit-funded win",
              body: "Minted when you win a lossless (credit-funded) parlay. Principal stays locked forever; earnings are fully liquid. Graduate to Full to commit to a 2-year lock and pick up the standard fee-share boost.",
            }}
          />
          <Connector />
          <TierRow
            label="Least"
            tier="least"
            shares={leastShares}
            positionCount={leastPositions.length}
            tooltipPlacement="top"
            tooltip={{
              title: "Least — losing parlay",
              body: "Minted when you lose a parlay. Your stake is locked here as productive capital and you get bet-only credit equal to 12 months of projected yield. If credit expires unspent, the principal reverts to LPs.",
            }}
          />
        </div>
      </div>

      {pendingBigInt > 0n && (
        <div className="rounded-xl border border-neon-green/20 bg-neon-green/5 p-4 text-center">
          <p className="text-sm text-gray-400">Pending Fee Rewards</p>
          <p className="text-xl font-bold text-neon-green">${formatUSDC(pendingBigInt)}</p>
        </div>
      )}
    </div>
  );
}

function Tooltip({ title, body, placement = "bottom" }: { title: string; body: string; placement?: "top" | "bottom" }) {
  const positionCls = placement === "top" ? "bottom-full mb-2" : "top-full mt-2";
  return (
    <div
      className={`pointer-events-none absolute left-1/2 z-50 w-64 -translate-x-1/2 rounded-lg border border-white/15 bg-gray-950 p-3 text-left opacity-0 shadow-2xl ring-1 ring-black/40 transition-opacity duration-150 group-hover:opacity-100 ${positionCls}`}
    >
      <p className="text-xs font-semibold text-white">{title}</p>
      <p className="mt-1 text-[11px] leading-snug text-gray-400">{body}</p>
    </div>
  );
}

function PositionBox({
  label,
  primary,
  secondary,
  accent,
  tooltip,
}: {
  label: string;
  primary: string;
  secondary: string;
  accent: "white" | "green";
  tooltip: { title: string; body: string };
}) {
  const accentCls = accent === "green" ? "border-neon-green/25 bg-neon-green/5" : "border-white/10 bg-white/[0.03]";
  const valueCls = accent === "green" ? "text-neon-green" : "text-white";
  return (
    <div className={`group relative rounded-xl border p-5 ${accentCls}`}>
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${valueCls}`}>{primary}</p>
      <p className="mt-0.5 text-[11px] text-gray-600">{secondary}</p>
      <Tooltip {...tooltip} />
    </div>
  );
}

function TierRow({
  label,
  tier,
  shares,
  positionCount,
  tooltip,
  tooltipPlacement,
}: {
  label: string;
  tier: "full" | "partial" | "least";
  shares: bigint;
  positionCount: number;
  tooltip: { title: string; body: string };
  tooltipPlacement?: "top" | "bottom";
}) {
  const styles = {
    full: {
      box: "border-brand-purple/30 bg-brand-purple/10",
      badge: "bg-brand-purple/20 text-brand-purple-1",
      text: "text-brand-purple-1",
    },
    partial: {
      box: "border-amber-500/30 bg-amber-500/10",
      badge: "bg-amber-500/20 text-amber-300",
      text: "text-amber-300",
    },
    least: {
      box: "border-gray-500/30 bg-gray-500/10",
      badge: "bg-gray-500/20 text-gray-400",
      text: "text-gray-400",
    },
  }[tier];
  return (
    <div className={`group relative flex items-center justify-between rounded-lg border px-4 py-3 ${styles.box}`}>
      <div className="flex items-center gap-3">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${styles.badge}`}>
          {label}
        </span>
        <span className={`text-sm font-semibold ${styles.text}`}>{formatUSDC(shares)} VOO</span>
      </div>
      <span className="text-xs text-gray-500">
        {positionCount} {positionCount === 1 ? "position" : "positions"}
      </span>
      <Tooltip {...tooltip} placement={tooltipPlacement} />
    </div>
  );
}

function Connector() {
  return (
    <div className="flex justify-center" aria-hidden>
      <svg width="14" height="10" viewBox="0 0 14 10" className="text-gray-600">
        <path
          d="M7 0 V8 M2 5 L7 9 L12 5"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "pink" | "purple" | "green" | "gold";
}) {
  const colors = {
    pink: "from-brand-pink/10 to-transparent border-brand-pink/20",
    purple: "from-brand-purple/10 to-transparent border-brand-purple/20",
    green: "from-neon-green/10 to-transparent border-neon-green/20",
    gold: "from-brand-gold/10 to-transparent border-brand-gold/20",
  };
  return (
    <div className={`glass-card bg-gradient-to-br p-6 ${colors[accent]}`}>
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-white">{value}</p>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent: "pink" | "purple" | "green" }) {
  const colors = {
    pink: "border-brand-pink/20 bg-brand-pink/5",
    purple: "border-brand-purple/20 bg-brand-purple/5",
    green: "border-neon-green/20 bg-neon-green/5",
  };
  return (
    <div className={`rounded-lg border px-3 py-2 ${colors[accent]}`}>
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className="text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function Cell({
  label,
  primary,
  secondary,
  primaryClass,
}: {
  label: string;
  primary: string;
  secondary: string;
  primaryClass: string;
}) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-lg font-semibold ${primaryClass}`}>{primary}</p>
      <p className="text-[10px] text-gray-600">{secondary}</p>
    </div>
  );
}
