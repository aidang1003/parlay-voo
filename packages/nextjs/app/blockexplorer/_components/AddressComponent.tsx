"use client";

import { BackButton } from "./BackButton";
import { ContractTabs } from "./ContractTabs";
import { Address, Balance } from "@scaffold-ui/components";
import { Address as AddressType } from "viem";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";

export const AddressComponent = ({
  address,
  contractData,
}: {
  address: AddressType;
  contractData: { bytecode: string; assembly: string } | null;
}) => {
  const { targetNetwork } = useTargetNetwork();
  return (
    <div className="space-y-6">
      <div className="flex justify-start">
        <BackButton />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex flex-col">
          <div className="overflow-x-auto rounded-2xl border border-white/5 bg-gray-900/40 px-6 py-4 lg:px-8">
            <div className="flex flex-col gap-1">
              <Address address={address} format="long" onlyEnsOrAddress chain={targetNetwork} />
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-400">Balance:</span>
                <Balance address={address} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <ContractTabs address={address} contractData={contractData} />
    </div>
  );
};
