"use client";

import { useEffect, useState } from "react";
import { MyPositionPanel } from "./MyPositionPanel";
import { formatUnits, parseUnits } from "viem";
import { useAccount } from "wagmi";
import {
  LockTier,
  useDepositVault,
  useEarlyWithdraw,
  useGraduate,
  useLockPositions,
  useLockStats,
  useLockVault,
  useMintTestUSDC,
  useUSDCBalance,
  useUnlockVault,
  useVaultPosition,
  useVaultStats,
  useWithdrawVault,
} from "~~/lib/hooks";
import { blockNonNumericKeys, formatUSDC as fmtUSDCShared, sanitizeNumericInput } from "~~/lib/utils";
import { LOCK_MIN_DURATION_SECS, feeShareForDuration, penaltyBpsForRemaining } from "~~/utils/parlay";

// Local alias so the dashboard keeps its preferred `toLocaleString`
// rendering ("1,234.56") without passing `{ locale: true }` at every call site.
const formatUSDC = (amount: bigint | undefined) => fmtUSDCShared(amount, { locale: true });

const SECS_PER_DAY = 86_400n;

// Slider operates on days. Range: 7d → 3650d (10y). Curve is log-weighted
// so the knee-over around 1-2yr lives in the middle of the slider travel.
const LOCK_MIN_DAYS = 7;
const LOCK_MAX_DAYS = 3650;
const LOCK_DEFAULT_DAYS = 365;

// Preset stops users can tap to snap the slider.
const LOCK_PRESETS: { label: string; days: number }[] = [
  { label: "1w", days: 7 },
  { label: "1mo", days: 30 },
  { label: "3mo", days: 90 },
  { label: "6mo", days: 180 },
  { label: "1yr", days: 365 },
  { label: "2yr", days: 730 },
  { label: "5yr", days: 1825 },
  { label: "10yr", days: 3650 },
];

function formatDuration(days: number): string {
  if (days < 30) return `${days} day${days === 1 ? "" : "s"}`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  const years = days / 365;
  if (Math.abs(years - Math.round(years)) < 0.02) {
    return `${Math.round(years)} year${Math.round(years) === 1 ? "" : "s"}`;
  }
  return `${years.toFixed(1)} years`;
}

function bpsToMultiplier(bps: bigint): string {
  const x = Number(bps) / 10_000;
  return `${x.toFixed(2)}x`;
}

function bpsToPercent(bps: bigint): string {
  const pct = Number(bps) / 100;
  return `${pct.toFixed(2)}%`;
}

// Log scale for the slider so small durations have proportional travel.
function sliderToDays(value: number): number {
  const logMin = Math.log(LOCK_MIN_DAYS);
  const logMax = Math.log(LOCK_MAX_DAYS);
  const days = Math.exp(logMin + (logMax - logMin) * (value / 1000));
  return Math.max(LOCK_MIN_DAYS, Math.min(LOCK_MAX_DAYS, Math.round(days)));
}
function daysToSlider(days: number): number {
  const logMin = Math.log(LOCK_MIN_DAYS);
  const logMax = Math.log(LOCK_MAX_DAYS);
  return Math.round(((Math.log(days) - logMin) / (logMax - logMin)) * 1000);
}

type Tab = "deposit" | "withdraw" | "lock";
type ViewTab = "myPosition" | "overview";

export function VaultDashboard() {
  const { address, isConnected, chain } = useAccount();
  const noUsdcWarning = `Your wallet needs USDC on ${chain?.name ?? "the connected"} network`;
  const vaultStats = useVaultStats();
  const { balance: usdcBalance } = useUSDCBalance();
  const { shares: userShares, assets: sharesValue } = useVaultPosition();
  const depositHook = useDepositVault();
  const withdrawHook = useWithdrawVault();
  const lockHook = useLockVault();
  const unlockHook = useUnlockVault();
  const earlyWithdrawHook = useEarlyWithdraw();
  const graduateHook = useGraduate();
  const { positions, refetch: refetchPositions } = useLockPositions();
  const lockStats = useLockStats();
  const mintHook = useMintTestUSDC();

  const [tab, setTab] = useState<Tab>("deposit");
  const [viewTab, setViewTab] = useState<ViewTab>("overview");
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [lockAmount, setLockAmount] = useState("");
  const [lockDays, setLockDays] = useState<number>(LOCK_DEFAULT_DAYS);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Default tab: My Position when connected, Vault Overview when not.
  useEffect(() => {
    if (isConnected) setViewTab("myPosition");
  }, [isConnected]);

  // Live preview derived from selected duration.
  const lockDurationSecs = BigInt(lockDays) * SECS_PER_DAY;
  const lockFeeShareBps = lockDurationSecs >= LOCK_MIN_DURATION_SECS ? feeShareForDuration(lockDurationSecs) : 10_000n;
  const lockDay0PenaltyBps = penaltyBpsForRemaining(lockDurationSecs);

  const userSharesBigInt = userShares;
  const userSharesValueBigInt = sharesValue;

  const hasShares = userSharesBigInt > 0n;

  const totalAssets = vaultStats.totalAssets ?? 0n;
  const totalReserved = vaultStats.totalReserved ?? 0n;
  const utilization = vaultStats.totalAssets ? vaultStats.utilization : 0;
  const freeLiquidity = vaultStats.freeLiquidity ?? 0n;

  // Cap withdrawable shares to what free liquidity can cover
  const withdrawableShares =
    userSharesValueBigInt > 0n && userSharesValueBigInt > freeLiquidity
      ? (userSharesBigInt * freeLiquidity) / userSharesValueBigInt
      : userSharesBigInt;

  const setDepositAmountAndReset = (val: string) => {
    depositHook.resetSuccess();
    setDepositAmount(val);
  };

  const setWithdrawAmountAndReset = (val: string) => {
    withdrawHook.resetSuccess();
    setWithdrawAmount(val);
  };

  const handleDeposit = async () => {
    const amount = parseFloat(depositAmount);
    if (!amount || amount < 1) return;
    const success = await depositHook.deposit(amount);
    if (success) setDepositAmount("");
  };

  const handleWithdraw = async () => {
    const amount = parseFloat(withdrawAmount);
    if (!amount || amount <= 0) return;
    if (!hasShares) return;
    const success = await withdrawHook.withdraw(amount);
    if (success) setWithdrawAmount("");
  };

  const handleLock = async () => {
    const amount = parseFloat(lockAmount);
    if (!amount || amount <= 0) return;
    const shares = parseUnits(amount.toString(), 6);
    const success = await lockHook.lock(shares, lockDurationSecs);
    if (success) {
      setLockAmount("");
      await refetchPositions();
      lockStats.refetch();
    }
  };

  const handleUnlock = async (positionId: bigint) => {
    await unlockHook.unlock(positionId);
    refetchPositions();
  };

  const handleEarlyWithdraw = async (positionId: bigint) => {
    await earlyWithdrawHook.earlyWithdraw(positionId);
    refetchPositions();
  };

  // Graduate always commits 2 years — it's the on-chain minimum for the FULL
  // promotion and also the knee in the fee-share curve, so offering a slider
  // here doesn't add real optionality.
  const GRADUATE_DURATION_SECS = 730n * 86_400n;
  const handleGraduate = async (positionId: bigint) => {
    const ok = await graduateHook.graduate(positionId, GRADUATE_DURATION_SECS);
    if (ok) {
      await refetchPositions();
      lockStats.refetch();
    }
  };

  const depositTxSuccess = depositHook.isSuccess && !depositHook.error;
  const withdrawTxSuccess = withdrawHook.isSuccess && !withdrawHook.error;

  const hasUSDC = (usdcBalance ?? 0n) > 0n;

  const safeParse = (val: string): bigint => {
    try {
      return val && parseFloat(val) > 0 ? parseUnits(val, 6) : 0n;
    } catch {
      return 0n;
    }
  };
  const depositAmountBigInt = safeParse(depositAmount);
  const withdrawAmountBigInt = safeParse(withdrawAmount);
  const lockAmountBigInt = safeParse(lockAmount);
  const depositParsed = depositAmount ? parseFloat(depositAmount) : NaN;
  const depositBelowMinimum =
    depositAmount !== "" && !isNaN(depositParsed) && depositParsed >= 0 && depositAmountBigInt < 1_000_000n;
  const depositNegative = depositAmount !== "" && !isNaN(depositParsed) && depositParsed < 0;
  const depositExceedsBalance =
    depositAmountBigInt > 0n && !depositBelowMinimum && depositAmountBigInt > (usdcBalance ?? 0n);
  const withdrawParsed = withdrawAmount ? parseFloat(withdrawAmount) : NaN;
  const withdrawBelowMinimum =
    withdrawAmount !== "" && !isNaN(withdrawParsed) && withdrawParsed > 0 && withdrawAmountBigInt === 0n;
  const withdrawExceedsShares = withdrawAmountBigInt > 0n && withdrawAmountBigInt > userSharesBigInt;
  const withdrawExceedsLiquidity =
    withdrawAmountBigInt > 0n && !withdrawExceedsShares && withdrawAmountBigInt > withdrawableShares;
  const lockParsed = lockAmount ? parseFloat(lockAmount) : NaN;
  const lockBelowMinimum = lockAmount !== "" && !isNaN(lockParsed) && lockParsed >= 0 && lockAmountBigInt < 1_000_000n;
  const lockExceedsShares = lockAmountBigInt > 0n && lockAmountBigInt > userSharesBigInt;
  // Guard: "." or other non-numeric strings parse to NaN — disable buttons
  const depositNotANumber = depositAmount !== "" && isNaN(depositParsed);
  const withdrawNotANumber = withdrawAmount !== "" && isNaN(withdrawParsed);
  const lockNotANumber = lockAmount !== "" && isNaN(lockParsed);

  // Post-withdrawal utilization warning (convert shares to assets for correct unit basis)
  const withdrawAmountAssets =
    userSharesBigInt > 0n ? (withdrawAmountBigInt * userSharesValueBigInt) / userSharesBigInt : 0n;
  const postWithdrawUtil = (() => {
    if (withdrawAmountAssets <= 0n || totalAssets <= 0n || totalReserved <= 0n) return 0;
    const remaining = totalAssets > withdrawAmountAssets ? totalAssets - withdrawAmountAssets : 0n;
    if (remaining === 0n) return 100;
    return Number((totalReserved * 10000n) / remaining) / 100;
  })();
  const withdrawHighUtilWarning =
    withdrawAmountBigInt > 0n && !withdrawExceedsShares && !withdrawExceedsLiquidity && postWithdrawUtil > 80;

  // Priority order: wallet > prerequisite > tx state > input validation > default
  function depositButtonLabel(): string {
    if (!isConnected) return "Connect Wallet";
    if (!hasUSDC) return "No USDC Balance";
    if (depositHook.isPending) return "Signing...";
    if (depositHook.isConfirming) return "Confirming...";
    if (depositTxSuccess) return "Deposited!";
    if (depositNegative) return "Invalid Amount";
    if (depositBelowMinimum) return "Minimum 1 USDC";
    if (depositExceedsBalance) return "Insufficient Balance";
    return "Deposit";
  }

  function withdrawButtonLabel(): string {
    if (!isConnected) return "Connect Wallet";
    if (!hasShares) return "No Shares";
    if (withdrawHook.isPending) return "Signing...";
    if (withdrawHook.isConfirming) return "Confirming...";
    if (withdrawTxSuccess) return "Withdrawn!";
    if (withdrawBelowMinimum) return "Amount Too Small";
    if (withdrawExceedsShares) return "Insufficient Shares";
    if (withdrawExceedsLiquidity) return "Insufficient Liquidity";
    return "Withdraw";
  }

  function lockButtonLabel(): string {
    if (!isConnected) return "Connect Wallet";
    if (!lockHook.ready) return "Not Deployed On This Network";
    if (!hasShares) return "Deposit USDC First";
    if (lockHook.isPending) return "Signing...";
    if (lockHook.isConfirming) return "Confirming...";
    if (lockHook.isSuccess) return "Locked!";
    if (lockBelowMinimum) return "Minimum 1 VOO";
    if (lockExceedsShares) return "Insufficient Shares";
    return "Lock Shares";
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      {/* Left column: tabbed personal vs global view */}
      <div className="space-y-6">
        {/* View tabs */}
        <div className="flex gap-1 rounded-xl border border-white/5 bg-gray-900/50 p-1">
          {[
            { key: "myPosition" as const, label: "My Position" },
            { key: "overview" as const, label: "Vault Overview" },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setViewTab(t.key)}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-all ${
                viewTab === t.key ? "gradient-bg text-white shadow-lg" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {viewTab === "myPosition" &&
          (mounted && isConnected ? (
            <>
              <MyPositionPanel variant="full" />
              {positions.length > 0 && (
                <div className="glass-card p-6">
                  <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-gray-500">
                    Your Lock Positions
                  </h3>
                  <div className="space-y-3">
                    {positions.map(({ id, position }) => {
                      const now = Math.floor(Date.now() / 1000);
                      const isPartial = position.tier === LockTier.PARTIAL;
                      const isLeast = position.tier === LockTier.LEAST;
                      const isFull = position.tier === LockTier.FULL;
                      const matured = !isPartial && now >= Number(position.unlockAt);
                      const daysLeft = matured || isPartial ? 0 : Math.ceil((Number(position.unlockAt) - now) / 86400);
                      const feeShareLabel = bpsToMultiplier(position.feeShareBps);
                      const durationDays = Number(position.duration / SECS_PER_DAY);
                      const tierBadge = isPartial
                        ? { label: "Partial", cls: "bg-amber-500/10 text-amber-300 border-amber-500/30" }
                        : isLeast
                          ? { label: "Least", cls: "bg-gray-500/10 text-gray-400 border-gray-500/30" }
                          : { label: "Full", cls: "bg-brand-purple/10 text-brand-purple-1 border-brand-purple/30" };
                      return (
                        <div key={id.toString()} className="rounded-lg bg-white/5 px-4 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-semibold text-white">{formatUSDC(position.shares)} VOO</p>
                                <span
                                  className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tierBadge.cls}`}
                                >
                                  {tierBadge.label}
                                </span>
                              </div>
                              <p className="mt-0.5 text-xs text-gray-500">
                                {isPartial
                                  ? `${feeShareLabel} fee share -- locked until you graduate`
                                  : isLeast
                                    ? "Principal routed to LPs -- no further claim"
                                    : `${feeShareLabel} fee share -- ${formatDuration(durationDays)}${
                                        matured ? " -- Matured" : ` -- ${daysLeft}d left`
                                      }`}
                              </p>
                            </div>
                            <div className="flex gap-2">
                              {isPartial && (
                                <button
                                  onClick={() => handleGraduate(id)}
                                  disabled={graduateHook.isPending || graduateHook.isConfirming}
                                  title="Commit this position to a 2-year FULL lock. Earns fee share + promo credit."
                                  className="rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-300 transition-all hover:bg-amber-500/30 disabled:opacity-50"
                                >
                                  {graduateHook.isPending
                                    ? "Signing..."
                                    : graduateHook.isConfirming
                                      ? "Confirming..."
                                      : "Graduate to Full"}
                                </button>
                              )}
                              {isFull && matured && (
                                <button
                                  onClick={() => handleUnlock(id)}
                                  disabled={unlockHook.isPending}
                                  className="rounded-lg bg-neon-green/20 px-3 py-1.5 text-xs font-semibold text-neon-green transition-all hover:bg-neon-green/30 disabled:opacity-50"
                                >
                                  {unlockHook.isPending ? "..." : "Unlock"}
                                </button>
                              )}
                              {isFull && !matured && (
                                <button
                                  onClick={() => handleEarlyWithdraw(id)}
                                  disabled={earlyWithdrawHook.isPending}
                                  className="rounded-lg bg-yellow-500/20 px-3 py-1.5 text-xs font-semibold text-yellow-400 transition-all hover:bg-yellow-500/30 disabled:opacity-50"
                                >
                                  {earlyWithdrawHook.isPending ? "..." : "Early Exit"}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {graduateHook.error && (
                    <p className="mt-2 rounded-lg bg-neon-red/10 px-3 py-2 text-center text-xs text-neon-red">
                      {graduateHook.error.message.length > 120
                        ? graduateHook.error.message.slice(0, 120) + "..."
                        : graduateHook.error.message}
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="glass-card p-10 text-center">
              <p className="text-sm text-gray-400">Connect your wallet to see your position.</p>
            </div>
          ))}

        {viewTab === "overview" && (
          <>
            {/* TVL composition: shows TVL = Reserved + Free, and Utilization = Reserved / TVL */}
            <div className="glass-card space-y-5 p-6">
              <div className="flex items-baseline justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Total TVL</p>
                  <p className="mt-1 text-3xl font-bold text-white">${formatUSDC(totalAssets)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Utilization</p>
                  <p className="mt-1 text-3xl font-bold text-brand-purple-1">{utilization.toFixed(1)}%</p>
                  <p className="text-[10px] text-gray-600">reserved &divide; TVL</p>
                </div>
              </div>

              {/* Stacked composition bar: Reserved (purple) | Free (green). Width sums to TVL. */}
              {totalAssets > 0n ? (
                <div className="space-y-2">
                  <div className="relative flex h-7 overflow-hidden rounded-full bg-gray-800">
                    <div
                      className="bg-gradient-to-r from-brand-pink to-brand-purple transition-all duration-700"
                      style={{ width: `${Math.min(utilization, 100)}%` }}
                      title={`Reserved · $${formatUSDC(totalReserved)}`}
                    />
                    <div
                      className="flex-1 bg-neon-green/40 transition-all duration-700"
                      title={`Free liquidity · $${formatUSDC(freeLiquidity)}`}
                    />
                    <div
                      className="absolute inset-y-0 border-l-2 border-dashed border-yellow-400/60"
                      style={{ left: "80%" }}
                      title="80% utilization cap"
                    />
                  </div>
                  <div className="flex justify-between text-[11px] text-gray-500">
                    <span>0%</span>
                    <span className="text-yellow-400/70">Max 80%</span>
                    <span>100%</span>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-white/5 bg-white/5 p-4 text-center text-xs text-gray-500">
                  No deposits yet — deposit USDC to activate the vault.
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-brand-purple/25 bg-brand-purple/5 p-4">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-gradient-to-r from-brand-pink to-brand-purple" />
                    <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Reserved</p>
                  </div>
                  <p className="mt-1 text-xl font-bold text-white">${formatUSDC(totalReserved)}</p>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    Locked to cover potential payouts on active tickets.
                  </p>
                </div>
                <div className="rounded-lg border border-neon-green/25 bg-neon-green/5 p-4">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-neon-green/60" />
                    <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Free Liquidity</p>
                  </div>
                  <p className="mt-1 text-xl font-bold text-white">${formatUSDC(freeLiquidity)}</p>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    TVL minus Reserved — available to back new tickets and withdrawals.
                  </p>
                </div>
              </div>
            </div>

            {/* Vault Mechanics */}
            <div className="glass-card p-6">
              <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-gray-500">Vault Mechanics</h2>
              <ul className="space-y-3 text-sm text-gray-400">
                {[
                  {
                    color: "bg-brand-pink",
                    text: "Deposits mint VOO shares (ERC4626-like). Withdrawals are capped by free liquidity, with an 80% utilization ceiling.",
                  },
                  {
                    color: "bg-brand-purple-1",
                    text: "The vault underwrites every active ticket: each ticket's potential payout is reserved on buy and released on settle / cashout.",
                  },
                  {
                    color: "bg-neon-green",
                    text: "Fee routing: 90% of ticket fees stream to lockers via LockVaultV2, 5% feeds the safety buffer, 5% stays in the vault. Plain (unlocked) VOO earns share-value appreciation only — lock to claim the 90% stream.",
                  },
                  {
                    color: "bg-brand-blue",
                    text: "Lock curve: VOO can be locked for any duration ≥ 7 days. Continuous fee-share boost — 1× at 7 days, exactly 2× at 1 year, asymptotic 4× ceiling.",
                  },
                  {
                    color: "bg-brand-gold",
                    text: "Losing stakes mint a Least lock (the bettor's principal stays locked) plus 12 months of projected yield as bet-only credit. Spend the credit lossless or forfeit the principal to LPs at expiry.",
                  },
                  {
                    color: "bg-amber-400",
                    text: "Winning a credit-funded (lossless) parlay mints a Partial position — principal locked forever, earnings fully liquid. Graduate Partial → Full to commit to a 2-year lock and pick up the standard fee share.",
                  },
                ].map((item, i) => (
                  <li key={i} className="flex gap-3">
                    <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${item.color}`} />
                    {item.text}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>

      {/* Right column: Sticky action panel */}
      <div>
        <div className="glass-card-glow sticky top-20 space-y-6 p-6">
          {/* Tab buttons */}
          <div className="flex gap-1 rounded-xl bg-white/5 p-1">
            {(["deposit", "withdraw", "lock"] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                data-state={tab === t ? "active" : "inactive"}
                className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-all ${
                  tab === t ? "gradient-bg text-white shadow-lg" : "text-gray-500 hover:text-gray-300"
                }`}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {/* Deposit */}
          {tab === "deposit" && (
            <div className="space-y-4">
              <p className="text-sm text-gray-400">Deposit USDC to earn yield from parlay fees and losses.</p>
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>Available USDC</span>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white">{formatUSDC(usdcBalance)}</span>
                  {isConnected && (
                    <button
                      onClick={() => mintHook.mint()}
                      disabled={mintHook.isPending || mintHook.isConfirming}
                      className="rounded-md bg-brand-pink/20 px-2 py-0.5 text-[10px] font-semibold text-brand-pink transition-colors hover:bg-brand-pink/30 disabled:opacity-50"
                    >
                      {mintHook.isPending
                        ? "Signing..."
                        : mintHook.isConfirming
                          ? "Minting..."
                          : mintHook.isSuccess
                            ? "Minted!"
                            : "+ Mint 1000"}
                    </button>
                  )}
                </div>
              </div>
              {mintHook.error && <p className="text-center text-xs text-red-400">{mintHook.error}</p>}
              <div className="relative" title={!hasUSDC ? noUsdcWarning : undefined}>
                <input
                  type="text"
                  inputMode="decimal"
                  value={depositAmount}
                  onKeyDown={blockNonNumericKeys}
                  onChange={e => setDepositAmountAndReset(sanitizeNumericInput(e.target.value))}
                  placeholder="Min 1 USDC"
                  disabled={!hasUSDC}
                  title={!hasUSDC ? noUsdcWarning : undefined}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 pr-16 text-white placeholder-gray-600 outline-none transition-colors focus:border-brand-pink/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
                {hasUSDC && (
                  <button
                    onClick={() => setDepositAmountAndReset(formatUnits(usdcBalance!, 6))}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-brand-pink/20 px-2 py-1 text-xs font-semibold text-brand-pink transition-colors hover:bg-brand-pink/30"
                  >
                    Max
                  </button>
                )}
              </div>
              {depositAmountBigInt > 0n && (
                <p className="text-right text-xs text-gray-500">= ${formatUSDC(depositAmountBigInt)}</p>
              )}
              {depositNegative && <p className="text-center text-xs text-neon-red">Amount must be positive</p>}
              {depositBelowMinimum && <p className="text-center text-xs text-neon-red">Minimum deposit is 1 USDC</p>}
              {depositExceedsBalance && <p className="text-center text-xs text-neon-red">Exceeds your USDC balance</p>}
              <button
                onClick={handleDeposit}
                disabled={
                  !isConnected ||
                  !hasUSDC ||
                  !depositAmount ||
                  depositNotANumber ||
                  depositNegative ||
                  depositBelowMinimum ||
                  depositExceedsBalance ||
                  depositHook.isPending ||
                  depositHook.isConfirming
                }
                title={isConnected && !hasUSDC ? noUsdcWarning : undefined}
                className="btn-gradient w-full rounded-xl py-3 text-sm font-bold uppercase tracking-wider text-white disabled:cursor-not-allowed disabled:!bg-none disabled:!bg-gray-800 disabled:!text-gray-500 disabled:!shadow-none"
              >
                {depositButtonLabel()}
              </button>
              {depositHook.error && (
                <p className="rounded-lg bg-neon-red/10 px-3 py-2 text-center text-xs text-neon-red">
                  {depositHook.error.message.length > 120
                    ? depositHook.error.message.slice(0, 120) + "..."
                    : depositHook.error.message}
                </p>
              )}
            </div>
          )}

          {/* Withdraw */}
          {tab === "withdraw" && (
            <div className="space-y-4">
              <p className="text-sm text-gray-400">
                {hasShares
                  ? "Withdraw your USDC. Subject to available (unreserved) liquidity."
                  : "You have no vault shares to withdraw."}
              </p>
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>Available Shares</span>
                <span className="font-semibold text-white">{formatUSDC(withdrawableShares)} VOO</span>
              </div>
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  value={withdrawAmount}
                  onKeyDown={blockNonNumericKeys}
                  onChange={e => setWithdrawAmountAndReset(sanitizeNumericInput(e.target.value))}
                  placeholder="Shares (VOO)"
                  disabled={!hasShares}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 pr-16 text-white placeholder-gray-600 outline-none transition-colors focus:border-brand-pink/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
                {hasShares && (
                  <button
                    onClick={() => setWithdrawAmountAndReset(formatUnits(withdrawableShares, 6))}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-brand-pink/20 px-2 py-1 text-xs font-semibold text-brand-pink transition-colors hover:bg-brand-pink/30"
                  >
                    Max
                  </button>
                )}
              </div>
              {withdrawAmountBigInt > 0n && (
                <p className="text-right text-xs text-gray-500">= {formatUSDC(withdrawAmountBigInt)} VOO</p>
              )}
              {withdrawBelowMinimum && <p className="text-center text-xs text-neon-red">Amount too small</p>}
              {withdrawExceedsShares && <p className="text-center text-xs text-neon-red">Exceeds your vault shares</p>}
              {withdrawExceedsLiquidity && (
                <p className="text-center text-xs text-neon-red">Exceeds available vault liquidity</p>
              )}
              {withdrawHighUtilWarning && (
                <p className="text-center text-xs text-yellow-400">
                  This withdrawal will push utilization to {postWithdrawUtil.toFixed(0)}%. New bets may be blocked.
                </p>
              )}
              <button
                onClick={handleWithdraw}
                disabled={
                  !isConnected ||
                  !hasShares ||
                  !withdrawAmount ||
                  withdrawNotANumber ||
                  withdrawBelowMinimum ||
                  withdrawExceedsShares ||
                  withdrawExceedsLiquidity ||
                  withdrawHook.isPending ||
                  withdrawHook.isConfirming
                }
                className="w-full rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-bold uppercase tracking-wider text-white transition-all hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {withdrawButtonLabel()}
              </button>
              {withdrawHook.error && (
                <p className="rounded-lg bg-neon-red/10 px-3 py-2 text-center text-xs text-neon-red">
                  {withdrawHook.error.message.length > 120
                    ? withdrawHook.error.message.slice(0, 120) + "..."
                    : withdrawHook.error.message}
                </p>
              )}
            </div>
          )}

          {/* Lock */}
          {tab === "lock" && (
            <div className="space-y-4">
              <p className="text-sm text-gray-400">
                Lock your vault shares for a fixed period to earn boosted fee share.
              </p>

              {/* Available shares */}
              <div className="rounded-lg bg-white/5 px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-400">Available VOO</span>
                  <span className="text-lg font-bold text-white">{formatUSDC(userSharesBigInt)}</span>
                </div>
                {hasShares && (
                  <p className="mt-1 text-xs text-gray-500">Worth ${formatUSDC(userSharesValueBigInt)} USDC</p>
                )}
                {!hasShares && mounted && isConnected && (
                  <p className="mt-1 text-xs text-yellow-400">Deposit USDC first to get vault shares.</p>
                )}
                {!hasShares && mounted && !isConnected && (
                  <p className="mt-1 text-xs text-gray-500">Connect your wallet to see your shares.</p>
                )}
              </div>

              {/* Duration slider + live preview */}
              <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-baseline justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-gray-500">Lock duration</p>
                    <p className="text-lg font-bold text-white">{formatDuration(lockDays)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs uppercase tracking-wider text-gray-500">Fee share</p>
                    <p className="text-lg font-bold text-brand-purple-1">{bpsToMultiplier(lockFeeShareBps)}</p>
                  </div>
                </div>

                <input
                  type="range"
                  min={0}
                  max={1000}
                  step={1}
                  value={daysToSlider(lockDays)}
                  onChange={e => setLockDays(sliderToDays(Number(e.target.value)))}
                  aria-label="Lock duration"
                  className="mt-3 w-full accent-brand-purple"
                />

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {LOCK_PRESETS.map(p => (
                    <button
                      key={p.days}
                      onClick={() => setLockDays(p.days)}
                      className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                        lockDays === p.days
                          ? "bg-brand-purple/30 text-white"
                          : "bg-white/5 text-gray-400 hover:bg-white/10"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg bg-black/20 px-3 py-2">
                    <p className="text-gray-500">Day-0 exit penalty</p>
                    <p className="text-sm font-semibold text-yellow-400">{bpsToPercent(lockDay0PenaltyBps)}</p>
                  </div>
                  <div className="rounded-lg bg-black/20 px-3 py-2">
                    <p className="text-gray-500">Unlocks</p>
                    <p className="text-sm font-semibold text-white">
                      {mounted ? new Date(Date.now() + lockDays * 86_400_000).toLocaleDateString() : "--"}
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-[10px] leading-snug text-gray-500">
                  Fee share is your slice of incoming locker fees -- not an APY. Realized yield depends on protocol fee
                  flow.
                </p>
              </div>

              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  value={lockAmount}
                  onKeyDown={blockNonNumericKeys}
                  onChange={e => setLockAmount(sanitizeNumericInput(e.target.value))}
                  placeholder="VOO shares to lock"
                  disabled={!hasShares}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 pr-16 text-white placeholder-gray-600 outline-none transition-colors focus:border-brand-purple/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
                {hasShares && (
                  <button
                    onClick={() => setLockAmount(formatUnits(userSharesBigInt, 6))}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-brand-purple/20 px-2 py-1 text-xs font-semibold text-brand-purple-1 transition-colors hover:bg-brand-purple/30"
                  >
                    Max
                  </button>
                )}
              </div>
              {lockAmountBigInt > 0n && (
                <p className="text-right text-xs text-gray-500">= {formatUSDC(lockAmountBigInt)} VOO</p>
              )}

              {lockBelowMinimum && <p className="text-center text-xs text-neon-red">Minimum lock is 1 VOO</p>}
              {lockExceedsShares && <p className="text-center text-xs text-neon-red">Exceeds your vault shares</p>}
              <button
                onClick={handleLock}
                disabled={
                  !isConnected ||
                  !lockHook.ready ||
                  !hasShares ||
                  !lockAmount ||
                  lockNotANumber ||
                  lockBelowMinimum ||
                  lockExceedsShares ||
                  lockHook.isPending ||
                  lockHook.isConfirming
                }
                className="btn-gradient w-full rounded-xl py-3 text-sm font-bold uppercase tracking-wider text-white disabled:cursor-not-allowed disabled:!bg-none disabled:!bg-gray-800 disabled:!text-gray-500 disabled:!shadow-none"
              >
                {lockButtonLabel()}
              </button>
              {lockHook.error && (
                <p className="rounded-lg bg-neon-red/10 px-3 py-2 text-center text-xs text-neon-red">
                  {lockHook.error.message.length > 120
                    ? lockHook.error.message.slice(0, 120) + "..."
                    : lockHook.error.message}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
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
