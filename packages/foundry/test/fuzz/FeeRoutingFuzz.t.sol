// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "../../src/MockUSDC.sol";
import {HouseVault} from "../../src/core/HouseVault.sol";
import {LegRegistry} from "../../src/core/LegRegistry.sol";
import {ParlayEngine} from "../../src/core/ParlayEngine.sol";
import {LockVaultV2} from "../../src/core/LockVaultV2.sol";
import {AdminOracleAdapter} from "../../src/oracle/AdminOracleAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LegStatus} from "../../src/interfaces/IOracleAdapter.sol";
import {FeeRouterSetup} from "../helpers/FeeRouterSetup.sol";
import {SignedBuy} from "../helpers/SignedBuy.sol";

contract FeeRoutingFuzzTest is FeeRouterSetup, SignedBuy {
    MockUSDC usdc;
    HouseVault vault;
    LegRegistry registry;
    ParlayEngine engine;
    LockVaultV2 lockVault;
    AdminOracleAdapter oracle;

    address owner = address(this);
    address alice = makeAddr("alice");
    address locker = makeAddr("locker");
    address safetyModule;

    uint256 constant BOOTSTRAP_ENDS = 1_000_000;
    uint256 constant CUTOFF = 600_000;
    uint256 constant RESOLVE = 700_000;
    uint256 constant DEADLINE = 550_000;

    function setUp() public {
        vm.warp(500_000);

        usdc = new MockUSDC();
        vault = new HouseVault(IERC20(address(usdc)));
        registry = new LegRegistry();
        oracle = new AdminOracleAdapter();
        engine = new ParlayEngine(vault, registry, IERC20(address(usdc)), BOOTSTRAP_ENDS);

        vault.setEngine(address(engine));
        registry.setEngine(address(engine));
        engine.setTrustedQuoteSigner(_signerAddr());
        lockVault = _wireFeeRouter(vault);
        safetyModule = vault.safetyModule();

        _mintBulk(owner, 100_000e6);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, owner);

        _mintBulk(locker, 50_000e6);
        vm.startPrank(locker);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(50_000e6, locker);
        IERC20(address(vault)).approve(address(lockVault), type(uint256).max);
        lockVault.lock(50_000e6, 30 days);
        vm.stopPrank();
    }

    function _mintBulk(address to, uint256 amount) internal {
        uint256 perCall = 10_000e6;
        while (amount > 0) {
            uint256 batch = amount > perCall ? perCall : amount;
            usdc.mint(to, batch);
            amount -= batch;
        }
    }

    function _legs() internal view returns (ParlayEngine.SourceLeg[] memory l) {
        l = new ParlayEngine.SourceLeg[](2);
        l[0] = _mkLeg("coingecko:eth", bytes32(uint256(1)), 500_000, address(oracle), CUTOFF, RESOLVE);
        l[1] = _mkLeg("coingecko:btc", bytes32(uint256(1)), 250_000, address(oracle), CUTOFF, RESOLVE);
    }

    function testFuzz_feeSplit_sumsExactly(uint256 stake) public {
        stake = bound(stake, 1e6, 900e6);
        _mintBulk(alice, stake);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);

        uint256 ticketId = _buySigned(engine, alice, _legs(), stake, DEADLINE);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 feeToLockers = (t.feePaid * 9000) / 10_000;
        uint256 feeToSafety = (t.feePaid * 500) / 10_000;
        uint256 feeToVault = t.feePaid - feeToLockers - feeToSafety;

        assertEq(feeToLockers + feeToSafety + feeToVault, t.feePaid, "sum");
    }

    function testFuzz_solvencyAfterRouting(uint256 stake) public {
        stake = bound(stake, 1e6, 900e6);
        _mintBulk(alice, stake);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);

        _buySigned(engine, alice, _legs(), stake, DEADLINE);
        assertLe(vault.totalReserved(), vault.totalAssets(), "solvency");
    }

    function testFuzz_routedAmountsMatchBalances(uint256 stake) public {
        stake = bound(stake, 1e6, 900e6);
        uint256 lockBefore = usdc.balanceOf(address(lockVault));
        uint256 safetyBefore = usdc.balanceOf(safetyModule);

        _mintBulk(alice, stake);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);

        uint256 ticketId = _buySigned(engine, alice, _legs(), stake, DEADLINE);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 expectedToLockers = (t.feePaid * 9000) / 10_000;
        uint256 expectedToSafety = (t.feePaid * 500) / 10_000;

        assertEq(usdc.balanceOf(address(lockVault)) - lockBefore, expectedToLockers, "lockVault");
        assertEq(usdc.balanceOf(safetyModule) - safetyBefore, expectedToSafety, "safety");
    }

    function testFuzz_lockerClaimsCorrectAmount(uint256 stake) public {
        stake = bound(stake, 1e6, 900e6);
        _mintBulk(alice, stake);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);

        uint256 ticketId = _buySigned(engine, alice, _legs(), stake, DEADLINE);
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 expectedToLockers = (t.feePaid * 9000) / 10_000;

        vm.prank(locker);
        lockVault.settleRewards(0);
        uint256 before = usdc.balanceOf(locker);
        vm.prank(locker);
        lockVault.claimFees();
        uint256 claimed = usdc.balanceOf(locker) - before;

        assertApproxEqAbs(claimed, expectedToLockers, 1, "claim");
    }

    function testFuzz_multipleTickets_accumulateCorrectly(uint256 stake1, uint256 stake2, uint256 stake3) public {
        stake1 = bound(stake1, 1e6, 200e6);
        stake2 = bound(stake2, 1e6, 200e6);
        stake3 = bound(stake3, 1e6, 200e6);

        uint256 totalStake = stake1 + stake2 + stake3;
        _mintBulk(alice, totalStake);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);

        uint256 lockBefore = usdc.balanceOf(address(lockVault));

        uint256 t1 = _buySigned(engine, alice, _legs(), stake1, DEADLINE);
        uint256 t2 = _buySigned(engine, alice, _legs(), stake2, DEADLINE);
        uint256 t3 = _buySigned(engine, alice, _legs(), stake3, DEADLINE);

        uint256 expected = (engine.getTicket(t1).feePaid * 9000) / 10_000
            + (engine.getTicket(t2).feePaid * 9000) / 10_000 + (engine.getTicket(t3).feePaid * 9000) / 10_000;

        assertEq(usdc.balanceOf(address(lockVault)) - lockBefore, expected, "cumulative");
    }

    function testFuzz_accumulatorNeverDecreases(uint256 stake1, uint256 stake2) public {
        stake1 = bound(stake1, 1e6, 400e6);
        stake2 = bound(stake2, 1e6, 400e6);

        _mintBulk(alice, stake1 + stake2);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);

        _buySigned(engine, alice, _legs(), stake1, DEADLINE);
        uint256 accAfterFirst = lockVault.accRewardPerWeightedShare();

        _buySigned(engine, alice, _legs(), stake2, DEADLINE);
        uint256 accAfterSecond = lockVault.accRewardPerWeightedShare();

        assertGe(accAfterSecond, accAfterFirst, "monotonic");
    }

    function testFuzz_vaultAssetsEquation(uint256 stake) public {
        stake = bound(stake, 1e6, 900e6);
        uint256 vaultBefore = vault.totalAssets();

        _mintBulk(alice, stake);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);

        uint256 ticketId = _buySigned(engine, alice, _legs(), stake, DEADLINE);
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 feeToLockers = (t.feePaid * 9000) / 10_000;
        uint256 feeToSafety = (t.feePaid * 500) / 10_000;

        assertEq(vault.totalAssets(), vaultBefore + stake - feeToLockers - feeToSafety, "equation");
    }

    function testFuzz_fullLifecycle_withRouting(uint256 stake) public {
        stake = bound(stake, 1e6, 900e6);
        _mintBulk(alice, stake);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);

        uint256 safetyBefore = usdc.balanceOf(safetyModule);

        uint256 ticketId = _buySigned(engine, alice, _legs(), stake, DEADLINE);
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 expectedToSafety = (t.feePaid * 500) / 10_000;

        assertEq(usdc.balanceOf(safetyModule) - safetyBefore, expectedToSafety, "safety");

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        engine.settleTicket(ticketId);

        uint256 bettorBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        engine.claimPayout(ticketId);
        assertEq(usdc.balanceOf(alice), bettorBefore + t.potentialPayout, "payout");

        assertLe(vault.totalReserved(), vault.totalAssets(), "solvency");
    }

    function testFuzz_usdcConservation(uint256 stake) public {
        stake = bound(stake, 1e6, 900e6);
        _mintBulk(alice, stake);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 vaultBefore = usdc.balanceOf(address(vault));
        uint256 lockBefore = usdc.balanceOf(address(lockVault));
        uint256 safetyBefore = usdc.balanceOf(safetyModule);
        uint256 totalBefore = aliceBefore + vaultBefore + lockBefore + safetyBefore;

        _buySigned(engine, alice, _legs(), stake, DEADLINE);

        uint256 totalAfter = usdc.balanceOf(alice) + usdc.balanceOf(address(vault))
            + usdc.balanceOf(address(lockVault)) + usdc.balanceOf(safetyModule);

        assertEq(totalAfter, totalBefore, "conservation");
    }
}
