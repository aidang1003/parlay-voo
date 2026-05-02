"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import {
  useUSDCBalance,
  useVaultPosition,
  useLockPositions,
  useLockStats,
  useCreditBalance,
} from "@/lib/hooks";
import { useDeployedContract } from "@/lib/hooks/useDeployedContract";
import { usePinnedChainId } from "@/lib/hooks/_internal";
import {
  LOCAL_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_MAINNET_CHAIN_ID,
  isCircleUsdc,
  type SupportedChainId,
} from "@parlayvoo/shared";
import { formatUSDC as fmtUSDCShared } from "@/lib/utils";

const formatUSDC = (amount: bigint | undefined) => fmtUSDCShared(amount, { locale: true });

function describeUSDCToken(
  chainId: SupportedChainId,
  address: string | undefined,
): { label: string; subtitle: string } {
  if (isCircleUsdc(chainId, address)) {
    if (chainId === BASE_SEPOLIA_CHAIN_ID) return { label: "USDC", subtitle: "Circle USDC · Base Sepolia" };
    if (chainId === BASE_MAINNET_CHAIN_ID) return { label: "USDC", subtitle: "Circle USDC · Base mainnet" };
  }
  if (chainId === LOCAL_CHAIN_ID) return { label: "MockUSDC", subtitle: "Local Anvil · test token" };
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return { label: "MockUSDC", subtitle: "Base Sepolia · test token" };
  return { label: "USDC", subtitle: "Base mainnet" };
}

export function HeaderPositionPill() {
  const { isConnected } = useAccount();
  const chainId = usePinnedChainId();
  const usdc = useDeployedContract("MockUSDC");
  const { balance: usdcBalance } = useUSDCBalance();
  const { assets: userSharesValue } = useVaultPosition();
  const { userTotalLocked } = useLockPositions();
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

  const usdcBigInt = usdcBalance ?? 0n;
  const totalVaultValue = userSharesValue + lockedValueBigInt;
  const pendingBigInt = pendingRewards ?? 0n;
  const creditBigInt = credit ?? 0n;

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  if (!isConnected) return null;

  const token = describeUSDCToken(chainId, usdc?.address);

  const handleEnter = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const handleLeave = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onFocus={handleEnter}
        onBlur={handleLeave}
        className="hidden items-center rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-brand-pink transition-colors hover:bg-white/10 sm:flex"
        aria-label="Wallet balance"
        aria-expanded={open}
      >
        ${formatUSDC(usdcBigInt)}
      </button>

      {open && (
        <div
          role="dialog"
          className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-white/15 bg-gray-950 p-4 shadow-2xl ring-1 ring-black/40"
        >
          <div className="mb-3 border-b border-white/10 pb-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              {token.label}
            </p>
            {token.subtitle && (
              <p className="mt-0.5 text-[11px] text-gray-500">{token.subtitle}</p>
            )}
            <p className="mt-1 text-base font-semibold text-brand-pink">
              ${formatUSDC(usdcBigInt)}
            </p>
          </div>
          <PopoverRow label="Vault value" value={`$${formatUSDC(totalVaultValue)}`} />
          <PopoverRow label="Unclaimed rewards" value={`$${formatUSDC(pendingBigInt)}`} />
          {creditBigInt > 0n && (
            <PopoverRow label="Lossless credit" value={`$${formatUSDC(creditBigInt)}`} />
          )}
        </div>
      )}
    </div>
  );
}

function PopoverRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-gray-500">{label}</span>
      <span className="font-semibold text-white">{value}</span>
    </div>
  );
}
