// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UmaOracleAdapter} from "../../src/oracle/UmaOracleAdapter.sol";
import {IOptimisticOracleV3} from "../../src/interfaces/IOptimisticOracleV3.sol";
import {LegStatus} from "../../src/interfaces/IOracleAdapter.sol";

/// @notice Fork test against the real UMA OOv3 deployment on Base Sepolia.
///         Requires BASE_SEPOLIA_RPC_URL (or NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL)
///         in env; skips gracefully when not present so CI without RPC access
///         doesn't fail.
///
/// Run: `pnpm test:fork` (wraps `forge test --fork-url ... --match-path test/fork/*`)
contract UmaOracleSepoliaForkTest is Test {
    // UMAprotocol/protocol/packages/core/networks/84532.json
    address constant UMA_OOV3 = 0x0F7fC5E6482f096380db6158f978167b57388deE;
    // Circle USDC on Base Sepolia
    address constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    uint64 constant LIVENESS = 120; // 2 minutes — enough to keep the test fast

    IOptimisticOracleV3 uma;
    IERC20 usdc;
    UmaOracleAdapter adapter;

    address asserter = makeAddr("asserter");

    function setUp() public {
        string memory rpc = vm.envOr(
            "BASE_SEPOLIA_RPC_URL", vm.envOr("NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL", string(""))
        );
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);

        uma = IOptimisticOracleV3(UMA_OOV3);
        usdc = IERC20(USDC_BASE_SEPOLIA);

        uint256 minBond = uma.getMinimumBond(USDC_BASE_SEPOLIA);
        adapter = new UmaOracleAdapter(uma, usdc, LIVENESS, minBond);

        // Fund the asserter with enough USDC to cover a bond.
        deal(USDC_BASE_SEPOLIA, asserter, minBond * 10);
        vm.prank(asserter);
        usdc.approve(address(adapter), type(uint256).max);
    }

    function test_happyPath_assertSettle() public {
        bytes memory claim =
            bytes("ParlayVoo leg 1 (Polymarket conditionId 0xdeadbeef) resolved YES per Polymarket.");

        vm.prank(asserter);
        bytes32 assertionId = adapter.assertOutcome(1, LegStatus.Won, bytes32(uint256(0xa1)), claim);
        assertFalse(adapter.canResolve(1), "pre-liveness: must not resolve");

        vm.warp(block.timestamp + LIVENESS + 1);

        // Anyone can settle. We use the asserter; any EOA works.
        adapter.settleMature(1);

        assertTrue(adapter.canResolve(1), "post-settle: must resolve");
        (LegStatus s, bytes32 o) = adapter.getStatus(1);
        assertEq(uint8(s), uint8(LegStatus.Won));
        assertEq(o, bytes32(uint256(0xa1)));

        console.log("happy-path gas baseline - assertionId:");
        console.logBytes32(assertionId);
    }

    function test_disputePath_staysPending() public {
        bytes memory claim = bytes("ParlayVoo leg 2 resolved YES per Polymarket.");

        vm.prank(asserter);
        bytes32 assertionId = adapter.assertOutcome(2, LegStatus.Won, bytes32(uint256(1)), claim);

        // Fund a disputer with enough USDC + approve UMA directly (disputeAssertion
        // is on UMA, not our adapter).
        address disputer = makeAddr("disputer");
        uint256 minBond = uma.getMinimumBond(USDC_BASE_SEPOLIA);
        deal(USDC_BASE_SEPOLIA, disputer, minBond * 2);
        vm.prank(disputer);
        usdc.approve(UMA_OOV3, minBond * 2);

        vm.prank(disputer);
        uma.disputeAssertion(assertionId, disputer);

        // Warp past liveness; dispute means settleAssertion reverts until DVM.
        vm.warp(block.timestamp + LIVENESS + 1);
        vm.expectRevert();
        adapter.settleMature(2);

        assertFalse(adapter.canResolve(2), "disputed: must stay pending");
        assertEq(adapter.assertionByLeg(2), assertionId);
    }
}
