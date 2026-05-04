"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isAddress, isHex } from "viem";
import { hardhat } from "viem/chains";
import { usePublicClient } from "wagmi";

export const SearchBar = () => {
  const [searchInput, setSearchInput] = useState("");
  const router = useRouter();

  const client = usePublicClient({ chainId: hardhat.id });

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isHex(searchInput)) {
      try {
        const tx = await client?.getTransaction({ hash: searchInput });
        if (tx) {
          router.push(`/blockexplorer/transaction/${searchInput}`);
          return;
        }
      } catch (error) {
        console.error("Failed to fetch transaction:", error);
      }
    }

    if (isAddress(searchInput)) {
      router.push(`/blockexplorer/address/${searchInput}`);
      return;
    }
  };

  return (
    <form onSubmit={handleSearch} className="mb-4 flex items-center justify-end gap-2">
      <input
        className="w-full rounded-lg border border-white/10 bg-gray-900/50 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-500 focus:border-brand-pink/40 focus:outline-none focus:ring-1 focus:ring-brand-pink/40 md:w-1/2 lg:w-1/3"
        type="text"
        value={searchInput}
        placeholder="Search by hash or address"
        onChange={e => setSearchInput(e.target.value)}
      />
      <button
        className="rounded-lg border border-brand-pink/40 bg-brand-pink/10 px-4 py-2 text-sm font-semibold text-brand-pink transition-colors hover:bg-brand-pink/20"
        type="submit"
      >
        Search
      </button>
    </form>
  );
};
