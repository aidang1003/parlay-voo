// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {LegRegistry} from "../contracts/core/LegRegistry.sol";
import {AdminOracleAdapter} from "../contracts/oracle/AdminOracleAdapter.sol";
import {LegStatus} from "../contracts/interfaces/IOracleAdapter.sol";
import {CodeConstants} from "./HelperConfig.s.sol";

/// @notice Force-resolve a single leg on the AdminOracleAdapter, simulating a
///         Polymarket resolution without waiting for the settlement cron's
///         Polymarket fetch. Use this to E2E test settlement: resolve every
///         leg on an active ticket, then press "Run settlement now" on
///         /admin/tickets — Phase B will pick it up and settle.
///
/// Usage:
///   pnpm resolve-leg:local   "0xabc…:yes" 1
///   pnpm resolve-leg:sepolia "0xabc…:yes" 1
///
/// Status enum (IOracleAdapter.LegStatus):
///   1 = Won, 2 = Lost, 3 = Voided.  (0 = Unresolved is rejected by the contract.)
///
/// Outcome bytes32 is derived from status:
///   Won    -> 0x01 (yes)
///   Lost   -> 0x02 (no)
///   Voided -> 0x00
///
/// Addresses (LegRegistry, AdminOracleAdapter) are read out of the latest
/// broadcast JSON for the current chain, same pattern as FundWallet.s.sol.
contract ResolveLeg is Script, CodeConstants {
    using stdJson for string;

    function _readAddressFromBroadcast(string memory contractName) internal view returns (address) {
        string memory path = string.concat("broadcast/Deploy.s.sol/", vm.toString(block.chainid), "/run-latest.json");
        string memory json = vm.readFile(path);
        bytes32 target = keccak256(bytes(contractName));
        for (uint256 i = 0; i < 256; i++) {
            string memory base = string.concat(".transactions[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, base)) break;
            string memory nameKey = string.concat(base, ".contractName");
            if (!vm.keyExistsJson(json, nameKey)) continue;
            bytes memory raw = vm.parseJson(json, nameKey);
            if (raw.length == 0) continue;
            string memory name = abi.decode(raw, (string));
            if (keccak256(bytes(name)) == target) {
                return json.readAddress(string.concat(base, ".contractAddress"));
            }
        }
        revert(string.concat(contractName, " not found in run-latest.json"));
    }

    function run(string calldata sourceRef, uint8 statusRaw) external {
        require(statusRaw >= 1 && statusRaw <= 3, "status must be 1=Won, 2=Lost, 3=Voided");
        LegStatus status = LegStatus(statusRaw);

        bytes32 outcome;
        if (status == LegStatus.Won) outcome = bytes32(uint256(1));
        else if (status == LegStatus.Lost) outcome = bytes32(uint256(2));
        else outcome = bytes32(0);

        address registry = _readAddressFromBroadcast("LegRegistry");
        address oracle = _readAddressFromBroadcast("AdminOracleAdapter");

        (uint256 legId, bool exists) = LegRegistry(registry).legIdBySourceRef(sourceRef);
        require(exists, "leg not found for sourceRef");

        uint256 key = block.chainid == LOCAL_CHAIN_ID
            ? vm.envOr("WARM_DEPLOYER_PRIVATE_KEY", ANVIL_ACCOUNT_0_KEY)
            : vm.envUint("WARM_DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(key);
        AdminOracleAdapter(oracle).resolve(legId, status, outcome);
        vm.stopBroadcast();

        console.log("LegRegistry:         ", registry);
        console.log("AdminOracleAdapter:  ", oracle);
        console.log("sourceRef:           ", sourceRef);
        console.log("legId:               ", legId);
        console.log("status (1W/2L/3V):   ", uint8(status));
    }
}
