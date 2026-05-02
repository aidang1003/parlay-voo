"use client";

import { useReadContract } from "wagmi";
import { useAccount } from "wagmi";
import {
  useUSDCBalance,
  useVaultPosition,
  useLockPositions,
  useLockStats,
  useCreditBalance,
  LockTier,
} from "@/lib/hooks";
import { useDeployedContract } from "@/lib/hooks/useDeployedContract";
import { formatUSDC as fmtUSDCShared } from "@/lib/utils";

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

  const fullPositions = positions.filter((p) => p.position.tier === LockTier.FULL);
  const partialPositions = positions.filter((p) => p.position.tier === LockTier.PARTIAL);
  const leastPositions = positions.filter((p) => p.position.tier === LockTier.LEAST);
  const fullShares = fullPositions.reduce((s, p) => s + p.position.shares, 0n);
  const partialShares = partialPositions.reduce((s, p) => s + p.position.shares, 0n);
  const leastShares = leastPositions.reduce((s, p) => s + p.position.shares, 0n);

  if (variant === "pill") {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Tile label="Wallet USDC" value={`$${formatUSDC(usdcBigInt)}`} accent="pink" />
        <Tile label="Vault value" value={`$${formatUSDC(totalPositionValue)}`} accent="purple" />
        <Tile label="Pending rewards" value={`$${formatUSDC(pendingBigInt)}`} accent="green" />
        {creditBigInt > 0n && (
          <Tile label="Lossless credit" value={`$${formatUSDC(creditBigInt)}`} accent="green" />
        )}
        {!isConnected && (
          <p className="col-span-full text-center text-xs text-gray-500">
            Connect your wallet to see your position.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Wallet USDC" value={`$${formatUSDC(usdcBigInt)}`} accent="pink" />
        <StatCard label="Total vault value" value={`$${formatUSDC(totalPositionValue)}`} accent="purple" />
        <StatCard label="Pending fee rewards" value={`$${formatUSDC(pendingBigInt)}`} accent="green" />
        <StatCard label="Lossless credit" value={`$${formatUSDC(creditBigInt)}`} accent="gold" />
      </div>

      <div className="glass-card p-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-gray-500">
          Your Vault Position
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Cell label="Vault VOO" primary={formatUSDC(userShares)} secondary={`$${formatUSDC(userSharesValue)}`} primaryClass="text-white" />
          <Cell label="Full locks" primary={formatUSDC(fullShares)} secondary={`${fullPositions.length} position(s)`} primaryClass="text-brand-purple-1" />
          <Cell label="Partial locks" primary={formatUSDC(partialShares)} secondary={`${partialPositions.length} rehab position(s)`} primaryClass="text-amber-300" />
          <Cell label="Least locks" primary={formatUSDC(leastShares)} secondary="principal routed to LPs" primaryClass="text-gray-400" />
          <Cell label="Lossless credit" primary={`$${formatUSDC(creditBigInt)}`} secondary="spend via lossless mode" primaryClass="text-neon-green" />
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

function Tile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "pink" | "purple" | "green";
}) {
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
