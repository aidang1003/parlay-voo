"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useUSDCBalance, useVaultPosition, useLockPositions } from "@/lib/hooks";
import { useReadContract } from "wagmi";
import { useDeployedContract } from "@/lib/hooks/useDeployedContract";
import { formatUSDC as fmtUSDCShared } from "@/lib/utils";
import { MyPositionPanel } from "./MyPositionPanel";

const formatUSDC = (amount: bigint | undefined) => fmtUSDCShared(amount, { locale: true });

/**
 * Compact `$USDC · $vault` pill that lives between the Help button and the
 * ConnectKit button. Hidden when disconnected. Click opens a popover with
 * the full personal panel — same component as the My Position tab body.
 */
export function HeaderPositionPill() {
  const { isConnected } = useAccount();
  const { balance: usdcBalance } = useUSDCBalance();
  const { assets: userSharesValue } = useVaultPosition();
  const { userTotalLocked } = useLockPositions();
  const vault = useDeployedContract("HouseVault");

  const { data: lockedValue } = useReadContract({
    address: vault?.address,
    abi: vault?.abi,
    functionName: "convertToAssets",
    args: userTotalLocked > 0n ? [userTotalLocked] : undefined,
    query: { enabled: !!vault && userTotalLocked > 0n, refetchInterval: 10_000 },
  });
  const lockedValueBigInt = (lockedValue as bigint | undefined) ?? 0n;

  const totalVaultValue = userSharesValue + lockedValueBigInt;
  const usdcBigInt = usdcBalance ?? 0n;

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!isConnected) return null;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="hidden items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/10 sm:flex"
        aria-label="My position"
      >
        <span className="text-brand-pink">${formatUSDC(usdcBigInt)}</span>
        <span className="text-gray-600">·</span>
        <span className="text-brand-purple-1">${formatUSDC(totalVaultValue)}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(92vw,420px)] rounded-xl border border-white/10 bg-bg/95 p-4 shadow-2xl backdrop-blur-xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-500">
            My Position
          </p>
          <MyPositionPanel variant="pill" />
        </div>
      )}
    </div>
  );
}
