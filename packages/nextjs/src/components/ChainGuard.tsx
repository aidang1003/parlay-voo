"use client";

import { useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { CHAINS, type SupportedChainId } from "@parlaycity/shared";
import { usePinnedChainId } from "@/lib/hooks/_internal";

/**
 * Surfaces a wallet/app chain mismatch BEFORE the user clicks any tx button.
 * Without this, every `writeContractAsync` silently issues a
 * `wallet_switchEthereumChain` request — if Anvil isn't added to MetaMask or
 * the popup is missed, the promise hangs and the UI "freezes".
 */
export function ChainGuard() {
  const { isConnected, chainId: walletChainId } = useAccount();
  const pinned = usePinnedChainId();
  const { switchChainAsync, isPending } = useSwitchChain();
  const [error, setError] = useState<string | null>(null);

  if (!isConnected || !walletChainId || walletChainId === pinned) return null;

  const pinnedName = CHAINS[pinned as SupportedChainId]?.name ?? `chain ${pinned}`;
  const walletName = CHAINS[walletChainId as SupportedChainId]?.name ?? `chain ${walletChainId}`;

  const handleSwitch = async () => {
    setError(null);
    try {
      await switchChainAsync({ chainId: pinned });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to switch — add ${pinnedName} to your wallet first`,
      );
    }
  };

  return (
    <div className="border-b border-yellow-500/20 bg-yellow-500/10 text-yellow-200">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm sm:px-6">
        <span>
          Wallet is on <b>{walletName}</b>, but this app is pinned to <b>{pinnedName}</b>.
          Transactions will hang until you switch.
          {error && <span className="ml-2 text-red-300">({error})</span>}
        </span>
        <button
          onClick={handleSwitch}
          disabled={isPending}
          className="rounded-md bg-yellow-500/20 px-3 py-1 text-xs font-semibold hover:bg-yellow-500/30 disabled:opacity-50"
        >
          {isPending ? "Switching…" : `Switch to ${pinnedName}`}
        </button>
      </div>
    </div>
  );
}
