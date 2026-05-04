"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PaginationButton, SearchBar, TransactionsTable } from "./_components";
import { ChevronLeft } from "lucide-react";
import type { NextPage } from "next";
import { hardhat } from "viem/chains";
import { useFetchBlocks } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { notification } from "~~/utils/scaffold-eth";

const BlockExplorer: NextPage = () => {
  const { blocks, transactionReceipts, currentPage, totalBlocks, setCurrentPage, error } = useFetchBlocks();
  const { targetNetwork } = useTargetNetwork();
  const [isLocalNetwork, setIsLocalNetwork] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (targetNetwork.id !== hardhat.id) {
      setIsLocalNetwork(false);
    }
  }, [targetNetwork.id]);

  useEffect(() => {
    if (targetNetwork.id === hardhat.id && error) {
      setHasError(true);
    }
  }, [targetNetwork.id, error]);

  useEffect(() => {
    if (!isLocalNetwork) {
      notification.error(
        <>
          <p className="mt-0 mb-1 font-bold">
            <code className="rounded bg-white/10 px-1 italic"> targetNetwork </code> is not localhost
          </p>
          <p className="m-0">
            - You are on <code className="rounded bg-white/10 px-1 italic">{targetNetwork.name}</code>. This block
            explorer is only for <code className="rounded bg-white/10 px-1 italic">localhost</code>.
          </p>
          <p className="mt-1 break-normal">
            - You can use{" "}
            <a className="text-brand-pink underline" href={targetNetwork.blockExplorers?.default.url}>
              {targetNetwork.blockExplorers?.default.name}
            </a>{" "}
            instead.
          </p>
        </>,
      );
    }
  }, [
    isLocalNetwork,
    targetNetwork.blockExplorers?.default.name,
    targetNetwork.blockExplorers?.default.url,
    targetNetwork.name,
  ]);

  useEffect(() => {
    if (hasError) {
      notification.error(
        <>
          <p className="mt-0 mb-1 font-bold">Cannot connect to local provider</p>
          <p className="m-0">
            - Did you forget to run <code className="rounded bg-white/10 px-1 italic">pnpm chain</code>?
          </p>
          <p className="mt-1 break-normal">
            - Or change <code className="rounded bg-white/10 px-1 italic">targetNetwork</code> in{" "}
            <code className="rounded bg-white/10 px-1 italic">scaffold.config.ts</code>.
          </p>
        </>,
      );
    }
  }, [hasError]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href="/admin/debug"
          className="inline-flex items-center gap-1 text-xs text-gray-500 transition-colors hover:text-gray-300"
        >
          <ChevronLeft className="h-3 w-3" />
          Back to Admin
        </Link>
        <h1 className="text-3xl font-black text-white">
          Block <span className="gradient-text">Explorer</span>
        </h1>
        <p className="text-gray-400">
          Recent blocks + transactions on the local anvil chain. Search by block number, address, or tx hash.
        </p>
      </header>

      <div className="rounded-2xl border border-white/5 bg-gray-900/30 p-4 sm:p-6">
        <SearchBar />
        <TransactionsTable blocks={blocks} transactionReceipts={transactionReceipts} />
        <PaginationButton currentPage={currentPage} totalItems={Number(totalBlocks)} setCurrentPage={setCurrentPage} />
      </div>
    </div>
  );
};

export default BlockExplorer;
