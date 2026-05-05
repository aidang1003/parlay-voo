"use client";

import { useEffect, useMemo } from "react";
import { ContractUI } from "./ContractUI";
import "@scaffold-ui/debug-contracts/styles.css";
import { useSessionStorage } from "usehooks-ts";
import { BarsArrowUpIcon } from "@heroicons/react/20/solid";
import { ContractName, GenericContract } from "~~/utils/scaffold-eth/contract";
import { useAllContracts } from "~~/utils/scaffold-eth/contractsData";

const selectedContractStorageKey = "scaffoldEth2.selectedContract";

export function DebugContracts() {
  const contractsData = useAllContracts();
  const contractNames = useMemo(
    () =>
      Object.keys(contractsData).sort((a, b) => {
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
      }) as ContractName[],
    [contractsData],
  );

  const [selectedContract, setSelectedContract] = useSessionStorage<ContractName>(
    selectedContractStorageKey,
    contractNames[0],
    { initializeWithValue: false },
  );

  useEffect(() => {
    if (!contractNames.includes(selectedContract)) {
      setSelectedContract(contractNames[0]);
    }
  }, [contractNames, selectedContract, setSelectedContract]);

  return (
    <div className="flex flex-col items-center justify-center gap-y-6 py-4 lg:gap-y-8 lg:py-6">
      {contractNames.length === 0 ? (
        <p className="mt-14 text-2xl text-gray-400">No contracts found!</p>
      ) : (
        <>
          {contractNames.length > 1 && (
            <div className="flex w-full max-w-7xl flex-row flex-wrap gap-2 px-2 pb-1 lg:px-4">
              {contractNames.map(contractName => {
                const active = contractName === selectedContract;
                return (
                  <button
                    key={contractName}
                    onClick={() => setSelectedContract(contractName)}
                    className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors ${
                      active
                        ? "border-brand-pink/40 bg-brand-pink/10 text-brand-pink"
                        : "border-white/10 bg-white/5 text-gray-300 hover:border-brand-pink/30 hover:bg-brand-pink/5 hover:text-brand-pink"
                    }`}
                  >
                    {contractName}
                    {(contractsData[contractName] as GenericContract)?.external && (
                      <span title="External contract">
                        <BarsArrowUpIcon className="h-4 w-4" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {contractNames.map(
            contractName =>
              contractName === selectedContract && <ContractUI key={contractName} contractName={contractName} />,
          )}
        </>
      )}
    </div>
  );
}
