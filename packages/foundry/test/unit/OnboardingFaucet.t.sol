// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OnboardingFaucet} from "../../src/peripheral/OnboardingFaucet.sol";
import {MockUSDC} from "../../src/MockUSDC.sol";

contract OnboardingFaucetTest is Test {
    OnboardingFaucet faucet;
    MockUSDC usdc;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        faucet = new OnboardingFaucet(address(usdc), owner);

        vm.deal(address(this), 10 ether);
        faucet.fund{value: 1 ether}();
    }

    // ── claimEth ──────────────────────────────────────────────────────────

    function test_claimEth_succeedsOnFirstCall() public {
        uint256 before = alice.balance;
        vm.prank(alice);
        faucet.claimEth();
        assertEq(alice.balance - before, 0.005 ether);
        assertTrue(faucet.ethClaimed(alice));
    }

    function test_claimEth_revertsOnSecondCall() public {
        vm.prank(alice);
        faucet.claimEth();

        vm.prank(alice);
        vm.expectRevert(OnboardingFaucet.AlreadyClaimedEth.selector);
        faucet.claimEth();
    }

    function test_claimEth_revertsWhenContractEmpty() public {
        vm.prank(owner);
        faucet.withdrawEth(1 ether);

        vm.prank(alice);
        vm.expectRevert(OnboardingFaucet.FaucetEmpty.selector);
        faucet.claimEth();
    }

    function test_claimEth_separateAddressesEachClaim() public {
        vm.prank(alice);
        faucet.claimEth();
        vm.prank(bob);
        faucet.claimEth();

        assertEq(alice.balance, 0.005 ether);
        assertEq(bob.balance, 0.005 ether);
    }

    // ── claimUsdc ─────────────────────────────────────────────────────────

    function test_claimUsdc_succeedsFirstTime() public {
        vm.prank(alice);
        faucet.claimUsdc();
        assertEq(usdc.balanceOf(alice), 10_000e6);
    }

    function test_claimUsdc_revertsDuringCooldown() public {
        vm.prank(alice);
        faucet.claimUsdc();

        vm.warp(block.timestamp + 23 hours);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                OnboardingFaucet.UsdcCooldownActive.selector,
                block.timestamp + 1 hours
            )
        );
        faucet.claimUsdc();
    }

    function test_claimUsdc_succeedsAfterCooldown() public {
        vm.prank(alice);
        faucet.claimUsdc();

        vm.warp(block.timestamp + 24 hours);

        vm.prank(alice);
        faucet.claimUsdc();
        assertEq(usdc.balanceOf(alice), 20_000e6);
    }

    function test_claimUsdc_neverHoldsUsdc() public {
        vm.prank(alice);
        faucet.claimUsdc();
        assertEq(usdc.balanceOf(address(faucet)), 0);
    }

    // ── owner controls ────────────────────────────────────────────────────

    function test_setDripParams_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        faucet.setDripParams(0.01 ether, 5_000e6, 12 hours);

        vm.prank(owner);
        faucet.setDripParams(0.01 ether, 5_000e6, 12 hours);
        assertEq(faucet.ethDripAmount(), 0.01 ether);
        assertEq(faucet.usdcDripAmount(), 5_000e6);
        assertEq(faucet.usdcCooldown(), 12 hours);
    }

    function test_setDripParams_appliesToNextClaim() public {
        vm.prank(owner);
        faucet.setDripParams(0.001 ether, 1e6, 1 hours);

        vm.prank(alice);
        faucet.claimEth();
        assertEq(alice.balance, 0.001 ether);

        vm.prank(alice);
        faucet.claimUsdc();
        assertEq(usdc.balanceOf(alice), 1e6);
    }

    function test_withdrawEth_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        faucet.withdrawEth(0.1 ether);
    }

    function test_withdrawEth_partial() public {
        uint256 before = owner.balance;
        vm.prank(owner);
        faucet.withdrawEth(0.3 ether);
        assertEq(owner.balance - before, 0.3 ether);
        assertEq(address(faucet).balance, 0.7 ether);
    }

    function test_withdrawEth_revertsWhenNotEnoughBalance() public {
        vm.prank(owner);
        vm.expectRevert(OnboardingFaucet.FaucetEmpty.selector);
        faucet.withdrawEth(2 ether);
    }

    // ── funding ───────────────────────────────────────────────────────────

    function test_fund_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit OnboardingFaucet.Funded(address(this), 0.5 ether);
        faucet.fund{value: 0.5 ether}();
    }

    function test_receive_acceptsBareTransfer() public {
        (bool ok,) = address(faucet).call{value: 0.5 ether}("");
        assertTrue(ok);
        assertEq(address(faucet).balance, 1.5 ether);
    }

    // ── fuzz ──────────────────────────────────────────────────────────────

    function testFuzz_claimEth_totalTransferredMatchesDrip(uint8 n) public {
        uint256 count = uint256(n) % 50 + 1;
        vm.prank(owner);
        faucet.withdrawEth(1 ether);
        faucet.fund{value: count * 0.005 ether}();

        uint256 totalBefore = address(faucet).balance;
        for (uint256 i = 0; i < count; i++) {
            address user = address(uint160(0x1000 + i));
            vm.prank(user);
            faucet.claimEth();
        }
        uint256 totalAfter = address(faucet).balance;
        assertEq(totalBefore - totalAfter, count * 0.005 ether);
    }
}
