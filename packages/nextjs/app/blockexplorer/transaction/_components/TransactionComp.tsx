"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Address } from "@scaffold-ui/components";
import { Hash, Transaction, TransactionReceipt, formatEther, formatUnits } from "viem";
import { hardhat } from "viem/chains";
import { usePublicClient } from "wagmi";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { decodeTransactionData, getFunctionDetails } from "~~/utils/scaffold-eth";
import { replacer } from "~~/utils/scaffold-eth/common";

const TransactionComp = ({ txHash }: { txHash: Hash }) => {
  const client = usePublicClient({ chainId: hardhat.id });
  const router = useRouter();
  const [transaction, setTransaction] = useState<Transaction>();
  const [receipt, setReceipt] = useState<TransactionReceipt>();
  const [functionCalled, setFunctionCalled] = useState<string>();

  const { targetNetwork } = useTargetNetwork();

  useEffect(() => {
    if (txHash && client) {
      const fetchTransaction = async () => {
        const tx = await client.getTransaction({ hash: txHash });
        const receipt = await client.getTransactionReceipt({ hash: txHash });

        const transactionWithDecodedData = decodeTransactionData(tx);
        setTransaction(transactionWithDecodedData);
        setReceipt(receipt);

        const functionCalled = transactionWithDecodedData.input.substring(0, 10);
        setFunctionCalled(functionCalled);
      };

      fetchTransaction();
    }
  }, [client, txHash]);

  return (
    <div className="space-y-6">
      <button
        onClick={() => router.back()}
        className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-300 transition-colors hover:border-brand-pink/40 hover:bg-brand-pink/10 hover:text-brand-pink"
      >
        ← Back
      </button>
      {transaction ? (
        <div className="rounded-2xl border border-white/5 bg-gray-900/40 p-6">
          <h2 className="mb-4 text-2xl font-black text-white">
            Transaction <span className="gradient-text">Details</span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-white/5">
                <Row
                  label="Transaction Hash"
                  value={<span className="break-all font-mono text-xs text-gray-300">{transaction.hash}</span>}
                />
                <Row
                  label="Block Number"
                  value={<span className="font-mono text-xs text-gray-300">{Number(transaction.blockNumber)}</span>}
                />
                <Row
                  label="From"
                  value={<Address address={transaction.from} format="long" onlyEnsOrAddress chain={targetNetwork} />}
                />
                <Row
                  label="To"
                  value={
                    !receipt?.contractAddress ? (
                      transaction.to && (
                        <Address address={transaction.to} format="long" onlyEnsOrAddress chain={targetNetwork} />
                      )
                    ) : (
                      <span className="flex items-center gap-2 text-xs text-gray-400">
                        Contract Creation:
                        <Address
                          address={receipt.contractAddress}
                          format="long"
                          onlyEnsOrAddress
                          chain={targetNetwork}
                        />
                      </span>
                    )
                  }
                />
                <Row
                  label="Value"
                  value={
                    <span className="font-mono text-xs text-gray-300">
                      {formatEther(transaction.value)} {targetNetwork.nativeCurrency.symbol}
                    </span>
                  }
                />
                <Row
                  label="Function called"
                  value={
                    <div className="w-full overflow-x-auto whitespace-nowrap md:max-w-[600px] lg:max-w-[800px]">
                      {functionCalled === "0x" ? (
                        <span className="text-xs text-gray-500">This transaction did not call any function.</span>
                      ) : (
                        <>
                          <span className="mr-2 text-xs text-gray-300">{getFunctionDetails(transaction)}</span>
                          <span className="rounded-full border border-brand-pink/40 bg-brand-pink/10 px-2 py-0.5 font-mono text-[11px] text-brand-pink">
                            {functionCalled}
                          </span>
                        </>
                      )}
                    </div>
                  }
                />
                <Row
                  label="Gas Price"
                  value={
                    <span className="font-mono text-xs text-gray-300">
                      {formatUnits(transaction.gasPrice || 0n, 9)} Gwei
                    </span>
                  }
                />
                <Row
                  label="Data"
                  value={
                    <textarea
                      readOnly
                      value={transaction.input}
                      className="h-[150px] w-full rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[11px] text-gray-300"
                    />
                  }
                />
                <Row
                  label="Logs"
                  value={
                    <ul className="space-y-1">
                      {receipt?.logs?.map((log, i) => (
                        <li key={i} className="font-mono text-[11px] text-gray-400">
                          <strong className="text-gray-300">Log {i} topics:</strong>{" "}
                          {JSON.stringify(log.topics, replacer, 2)}
                        </li>
                      ))}
                    </ul>
                  }
                />
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="text-2xl text-gray-400">Loading…</p>
      )}
    </div>
  );
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr className="align-top">
      <td className="py-3 pr-4 text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</td>
      <td className="py-3 text-gray-300">{value}</td>
    </tr>
  );
}

export default TransactionComp;
