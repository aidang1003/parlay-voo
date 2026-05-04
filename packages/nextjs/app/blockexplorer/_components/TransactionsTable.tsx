import { TransactionHash } from "./TransactionHash";
import { Address } from "@scaffold-ui/components";
import { formatEther } from "viem";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { TransactionWithFunction } from "~~/utils/scaffold-eth";
import { TransactionsTableProps } from "~~/utils/scaffold-eth/";

export const TransactionsTable = ({ blocks, transactionReceipts }: TransactionsTableProps) => {
  const { targetNetwork } = useTargetNetwork();

  return (
    <div className="flex justify-center">
      <div className="w-full overflow-x-auto rounded-xl border border-white/5 bg-gray-900/40">
        <table className="w-full table-auto text-sm">
          <thead className="border-b border-white/5 bg-white/5 text-left text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 font-semibold">Transaction Hash</th>
              <th className="px-4 py-3 font-semibold">Function Called</th>
              <th className="px-4 py-3 font-semibold">Block Number</th>
              <th className="px-4 py-3 font-semibold">Time Mined</th>
              <th className="px-4 py-3 font-semibold">From</th>
              <th className="px-4 py-3 font-semibold">To</th>
              <th className="px-4 py-3 text-end font-semibold">Value ({targetNetwork.nativeCurrency.symbol})</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {blocks.map(block =>
              (block.transactions as TransactionWithFunction[]).map(tx => {
                const receipt = transactionReceipts[tx.hash];
                const timeMined = new Date(Number(block.timestamp) * 1000).toLocaleString();
                const functionCalled = tx.input.substring(0, 10);

                return (
                  <tr key={tx.hash} className="text-gray-300 transition-colors hover:bg-white/5">
                    <td className="px-4 py-3">
                      <TransactionHash hash={tx.hash} />
                    </td>
                    <td className="px-4 py-3">
                      {tx.functionName === "0x" ? "" : <span className="mr-1 text-gray-300">{tx.functionName}</span>}
                      {functionCalled !== "0x" && (
                        <span className="rounded-full border border-brand-pink/40 bg-brand-pink/10 px-2 py-0.5 font-mono text-[11px] text-brand-pink">
                          {functionCalled}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">{block.number?.toString()}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{timeMined}</td>
                    <td className="px-4 py-3">
                      <Address address={tx.from} size="sm" onlyEnsOrAddress chain={targetNetwork} />
                    </td>
                    <td className="px-4 py-3">
                      {!receipt?.contractAddress ? (
                        tx.to && <Address address={tx.to} size="sm" onlyEnsOrAddress chain={targetNetwork} />
                      ) : (
                        <div className="relative">
                          <Address address={receipt.contractAddress} size="sm" onlyEnsOrAddress chain={targetNetwork} />
                          <small className="absolute top-4 left-4 text-[10px] text-gray-500">(Contract Creation)</small>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-300">
                      {formatEther(tx.value)} {targetNetwork.nativeCurrency.symbol}
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
