// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "../../contracts/MockUSDC.sol";
import {HouseVault} from "../../contracts/core/HouseVault.sol";
import {LegRegistry} from "../../contracts/core/LegRegistry.sol";
import {ParlayEngine} from "../../contracts/core/ParlayEngine.sol";
import {LockVaultV2} from "../../contracts/core/LockVaultV2.sol";
import {ILockVault} from "../../contracts/interfaces/ILockVault.sol";
import {AdminOracleAdapter} from "../../contracts/oracle/AdminOracleAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LegStatus} from "../../contracts/interfaces/IOracleAdapter.sol";
import {FeeRouterSetup} from "../helpers/FeeRouterSetup.sol";
import {SignedBuy} from "../helpers/SignedBuy.sol";

contract FeeRoutingTest is FeeRouterSetup, SignedBuy {
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
        vault = new HouseVault(IERC20(address(usdc)), 8000, 1_000_000, 3);
        registry = new LegRegistry();
        oracle = new AdminOracleAdapter();
        engine = new ParlayEngine(vault, registry, IERC20(address(usdc)), BOOTSTRAP_ENDS, 1000);

        vault.setEngine(address(engine));
        registry.setEngine(address(engine));
        engine.setTrustedQuoteSigner(_signerAddr());

        lockVault = _wireFeeRouter(vault);
        safetyModule = vault.safetyModule();

        usdc.mint(owner, 10_000e6);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e6, owner);

        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);

        usdc.mint(locker, 5_000e6);
        vm.startPrank(locker);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(5_000e6, locker);
        IERC20(address(vault)).approve(address(lockVault), type(uint256).max);
        lockVault.lock(5_000e6, 30 days);
        vm.stopPrank();
    }

    function _legs() internal view returns (ParlayEngine.SourceLeg[] memory l) {
        l = new ParlayEngine.SourceLeg[](2);
        l[0] = _mkLeg("coingecko:eth", bytes32(uint256(1)), 500_000, address(oracle), CUTOFF, RESOLVE);
        l[1] = _mkLeg("coingecko:btc", bytes32(uint256(1)), 250_000, address(oracle), CUTOFF, RESOLVE);
    }

    // ── Fee Split Accuracy ──────────────────────────────────────────────

    function test_feeRouting_correctSplit() public {
        uint256 lockVaultUsdcBefore = usdc.balanceOf(address(lockVault));
        uint256 safetyUsdcBefore = usdc.balanceOf(safetyModule);
        uint256 vaultAssetsBefore = vault.totalAssets();

        uint256 ticketId = _buySigned(engine, alice, _legs(), 50e6, DEADLINE);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 feePaid = t.feePaid;
        // protocolFeeBps=1000 (10%), 2 legs → effective = 1 - 0.9² = 0.19. 50 × 0.19 = 9.5 USDC.
        assertEq(feePaid, 9_500_000, "feePaid = 9.5 USDC");

        uint256 expectedToLockers = (feePaid * 9000) / 10_000;
        uint256 expectedToSafety = (feePaid * 500) / 10_000;
        uint256 expectedToVault = feePaid - expectedToLockers - expectedToSafety;

        assertEq(usdc.balanceOf(address(lockVault)) - lockVaultUsdcBefore, expectedToLockers, "LockVault 90%");
        assertEq(usdc.balanceOf(safetyModule) - safetyUsdcBefore, expectedToSafety, "SafetyModule 5%");

        uint256 expectedVaultAssets = vaultAssetsBefore + 50e6 - expectedToLockers - expectedToSafety;
        assertEq(vault.totalAssets(), expectedVaultAssets, "Vault assets");
        assertEq(expectedToLockers + expectedToSafety + expectedToVault, feePaid, "sum");
    }

    function test_feeRouting_lockVaultAccumulatorUpdated() public {
        uint256 accBefore = lockVault.accRewardPerWeightedShare();
        _buySigned(engine, alice, _legs(), 50e6, DEADLINE);
        uint256 accAfter = lockVault.accRewardPerWeightedShare();
        assertGt(accAfter, accBefore, "Accumulator should increase");
    }

    function test_feeRouting_lockerCanClaimFees() public {
        uint256 ticketId = _buySigned(engine, alice, _legs(), 50e6, DEADLINE);
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 expectedToLockers = (t.feePaid * 9000) / 10_000;

        vm.prank(locker);
        lockVault.settleRewards(0);

        uint256 lockerBefore = usdc.balanceOf(locker);
        vm.prank(locker);
        lockVault.claimFees();

        uint256 claimed = usdc.balanceOf(locker) - lockerBefore;
        assertApproxEqAbs(claimed, expectedToLockers, 1, "Locker ~90% fee share");
    }

    // ── buyTicketSigned Reverts Without Fee Config ──────────────────────

    function test_feeRouting_revertsWithoutConfig() public {
        HouseVault freshVault = new HouseVault(IERC20(address(usdc)), 8000, 1_000_000, 3);
        LegRegistry freshRegistry = new LegRegistry();
        ParlayEngine freshEngine =
            new ParlayEngine(freshVault, freshRegistry, IERC20(address(usdc)), BOOTSTRAP_ENDS, 1000);
        freshVault.setEngine(address(freshEngine));
        freshRegistry.setEngine(address(freshEngine));
        freshEngine.setTrustedQuoteSigner(_signerAddr());

        usdc.mint(owner, 10_000e6);
        usdc.approve(address(freshVault), type(uint256).max);
        freshVault.deposit(10_000e6, owner);

        usdc.mint(alice, 10e6);
        vm.prank(alice);
        usdc.approve(address(freshEngine), type(uint256).max);

        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 10e6, _legs(), DEADLINE, nonce);
        bytes memory sig = _signQuote(freshEngine, SIGNER_PK, q);
        vm.prank(alice);
        vm.expectRevert("HouseVault: lockVault not configured");
        freshEngine.buyTicketSigned(q, sig);
    }

    function test_feeRouting_revertsWithoutSafetyModule() public {
        HouseVault freshVault = new HouseVault(IERC20(address(usdc)), 8000, 1_000_000, 3);
        LegRegistry freshRegistry = new LegRegistry();
        ParlayEngine freshEngine =
            new ParlayEngine(freshVault, freshRegistry, IERC20(address(usdc)), BOOTSTRAP_ENDS, 1000);
        LockVaultV2 freshLockVault = new LockVaultV2(freshVault);
        freshVault.setEngine(address(freshEngine));
        freshRegistry.setEngine(address(freshEngine));
        freshEngine.setTrustedQuoteSigner(_signerAddr());
        freshVault.setLockVault(freshLockVault);
        freshLockVault.setFeeDistributor(address(freshVault));

        usdc.mint(owner, 10_000e6);
        usdc.approve(address(freshVault), type(uint256).max);
        freshVault.deposit(10_000e6, owner);

        usdc.mint(alice, 50e6);
        vm.prank(alice);
        usdc.approve(address(freshEngine), type(uint256).max);

        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 50e6, _legs(), DEADLINE, nonce);
        bytes memory sig = _signQuote(freshEngine, SIGNER_PK, q);
        vm.prank(alice);
        vm.expectRevert("HouseVault: safetyModule not configured");
        freshEngine.buyTicketSigned(q, sig);
    }

    function test_feeRouting_solvencyInvariantHolds() public {
        _buySigned(engine, alice, _legs(), 50e6, DEADLINE);
        assertLe(vault.totalReserved(), vault.totalAssets(), "Solvency");
    }

    function test_feeRouting_zeroFeeNoRouting() public {
        engine.setProtocolFeeBps(0);

        uint256 lockVaultBefore = usdc.balanceOf(address(lockVault));
        uint256 safetyBefore = usdc.balanceOf(safetyModule);

        _buySigned(engine, alice, _legs(), 10e6, DEADLINE);

        assertEq(usdc.balanceOf(address(lockVault)), lockVaultBefore, "no LockVault routing");
        assertEq(usdc.balanceOf(safetyModule), safetyBefore, "no Safety routing");
    }

    function test_feeRouting_dustGoesToVault() public {
        uint256 ticketId = _buySigned(engine, alice, _legs(), 10e6, DEADLINE);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 feeToLockers = (t.feePaid * 9000) / 10_000;
        uint256 feeToSafety = (t.feePaid * 500) / 10_000;
        uint256 feeToVault = t.feePaid - feeToLockers - feeToSafety;

        assertEq(feeToLockers + feeToSafety + feeToVault, t.feePaid, "sum == feePaid");
    }

    function test_feeRouting_emitsEvents() public {
        // 50 USDC × (1 - 0.9²) = 9.5 USDC fee.
        uint256 expectedFee = 9_500_000;
        uint256 expectedToLockers = (expectedFee * 9000) / 10_000;
        uint256 expectedToSafety = (expectedFee * 500) / 10_000;
        uint256 expectedToVault = expectedFee - expectedToLockers - expectedToSafety;

        vm.expectEmit(true, true, true, true);
        emit ParlayEngine.FeesRouted(0, expectedToLockers, expectedToSafety, expectedToVault);

        _buySigned(engine, alice, _legs(), 50e6, DEADLINE);
    }

    function test_feeRouting_multipleTicketsAccumulate() public {
        uint256 lockVaultBefore = usdc.balanceOf(address(lockVault));

        _buySigned(engine, alice, _legs(), 10e6, DEADLINE);
        _buySigned(engine, alice, _legs(), 20e6, DEADLINE);
        _buySigned(engine, alice, _legs(), 30e6, DEADLINE);

        // 2-leg ticket fee = stake × (1 - 0.9²) = stake × 0.19, so 1900 BPS effective.
        uint256 fee1 = (10e6 * 1900) / 10_000;
        uint256 fee2 = (20e6 * 1900) / 10_000;
        uint256 fee3 = (30e6 * 1900) / 10_000;
        uint256 piecewiseLockers = (fee1 * 9000) / 10_000 + (fee2 * 9000) / 10_000 + (fee3 * 9000) / 10_000;

        assertEq(usdc.balanceOf(address(lockVault)) - lockVaultBefore, piecewiseLockers, "cumulative");
    }

    function test_notifyFees_onlyFeeDistributor() public {
        vm.prank(alice);
        vm.expectRevert("LockVaultV2: caller is not fee distributor");
        lockVault.notifyFees(1e6);
    }

    function test_routeFees_onlyEngine() public {
        vm.prank(alice);
        vm.expectRevert("HouseVault: caller is not engine");
        vault.routeFees(1e6, 1e6, 0);
    }

    function test_setLockVault_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setLockVault(lockVault);
    }

    function test_setSafetyModule_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setSafetyModule(safetyModule);
    }

    function test_setFeeDistributor_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        lockVault.setFeeDistributor(address(vault));
    }

    function test_setLockVault_zeroAddress_reverts() public {
        vm.expectRevert("HouseVault: zero address");
        vault.setLockVault(ILockVault(address(0)));
    }

    function test_setSafetyModule_zeroAddress_reverts() public {
        vm.expectRevert("HouseVault: zero address");
        vault.setSafetyModule(address(0));
    }

    function test_setFeeDistributor_zeroAddress_reverts() public {
        vm.expectRevert("LockVaultV2: zero address");
        lockVault.setFeeDistributor(address(0));
    }

    function test_feeRouting_settlementStillWorks() public {
        uint256 ticketId = _buySigned(engine, alice, _legs(), 10e6, DEADLINE);

        oracle.resolve(0, LegStatus.Won, keccak256("yes"));
        oracle.resolve(1, LegStatus.Won, keccak256("yes"));
        engine.settleTicket(ticketId);

        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(uint8(t.status), uint8(ParlayEngine.TicketStatus.Won));

        uint256 bettorBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        engine.claimPayout(ticketId);
        assertEq(usdc.balanceOf(alice), bettorBefore + t.potentialPayout);
    }

    function test_notifyFees_noLockers_isNoOp() public {
        HouseVault freshVault = new HouseVault(IERC20(address(usdc)), 8000, 1_000_000, 3);
        LockVaultV2 freshLockVault = new LockVaultV2(freshVault);
        freshLockVault.setFeeDistributor(address(freshVault));

        usdc.mint(address(freshLockVault), 1e6);
        vm.prank(address(freshVault));
        freshLockVault.notifyFees(1e6);

        assertEq(freshLockVault.accRewardPerWeightedShare(), 0);
        assertEq(freshLockVault.undistributedFees(), 1e6);
    }

    function test_undistributedFees_flowToFirstLocker() public {
        HouseVault freshVault = new HouseVault(IERC20(address(usdc)), 8000, 1_000_000, 3);
        LegRegistry freshRegistry = new LegRegistry();
        LockVaultV2 freshLockVault = new LockVaultV2(freshVault);
        ParlayEngine freshEngine =
            new ParlayEngine(freshVault, freshRegistry, IERC20(address(usdc)), BOOTSTRAP_ENDS, 1000);
        freshVault.setEngine(address(freshEngine));
        freshRegistry.setEngine(address(freshEngine));
        freshEngine.setTrustedQuoteSigner(_signerAddr());
        freshVault.setLockVault(freshLockVault);
        freshVault.setSafetyModule(safetyModule);
        freshLockVault.setFeeDistributor(address(freshVault));

        usdc.mint(owner, 10_000e6);
        usdc.approve(address(freshVault), type(uint256).max);
        freshVault.deposit(10_000e6, owner);

        usdc.mint(alice, 50e6);
        vm.prank(alice);
        usdc.approve(address(freshEngine), type(uint256).max);

        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(alice, 50e6, _legs(), DEADLINE, nonce);
        bytes memory sig = _signQuote(freshEngine, SIGNER_PK, q);
        vm.prank(alice);
        freshEngine.buyTicketSigned(q, sig);

        // protocolFeeBps=1000 (10%) per leg, 2 legs → 1900 BPS effective.
        uint256 expectedFee = (50e6 * 1900) / 10_000;
        uint256 expectedToLockers = (expectedFee * 9000) / 10_000;
        assertEq(freshLockVault.undistributedFees(), expectedToLockers, "undistributed");

        address firstLocker = makeAddr("firstLocker");
        usdc.mint(firstLocker, 5_000e6);
        vm.startPrank(firstLocker);
        usdc.approve(address(freshVault), type(uint256).max);
        uint256 shares = freshVault.deposit(5_000e6, firstLocker);
        IERC20(address(freshVault)).approve(address(freshLockVault), type(uint256).max);
        freshLockVault.lock(shares, 30 days);
        vm.stopPrank();

        assertEq(freshLockVault.undistributedFees(), 0, "cleared");

        vm.prank(firstLocker);
        freshLockVault.settleRewards(0);
        vm.prank(firstLocker);
        freshLockVault.claimFees();

        assertApproxEqAbs(usdc.balanceOf(firstLocker), expectedToLockers, 1, "first locker captures");
    }

    function test_twoLockers_proportionalShares() public {
        address locker2 = makeAddr("locker2");
        usdc.mint(locker2, 5_000e6);
        vm.startPrank(locker2);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(5_000e6, locker2);
        IERC20(address(vault)).approve(address(lockVault), type(uint256).max);
        lockVault.lock(5_000e6, 90 days);
        vm.stopPrank();

        uint256 ticketId = _buySigned(engine, alice, _legs(), 50e6, DEADLINE);
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        uint256 feeToLockers = (t.feePaid * 9000) / 10_000;

        vm.prank(locker);
        lockVault.settleRewards(0);
        uint256 locker1Before = usdc.balanceOf(locker);
        vm.prank(locker);
        lockVault.claimFees();
        uint256 locker1Claimed = usdc.balanceOf(locker) - locker1Before;

        vm.prank(locker2);
        lockVault.settleRewards(1);
        uint256 locker2Before = usdc.balanceOf(locker2);
        vm.prank(locker2);
        lockVault.claimFees();
        uint256 locker2Claimed = usdc.balanceOf(locker2) - locker2Before;

        assertApproxEqAbs(locker1Claimed + locker2Claimed, feeToLockers, 2, "combined");
        assertGt(locker2Claimed, locker1Claimed, "higher tier");
    }

    function test_routeFees_usesFreeLiquidity() public {
        usdc.mint(alice, 400e6);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);

        for (uint256 i = 0; i < 8; i++) {
            _buySigned(engine, alice, _legs(), 50e6, DEADLINE);
        }

        uint256 free = vault.freeLiquidity();

        vm.prank(address(engine));
        vm.expectRevert("HouseVault: insufficient free liquidity for routing");
        vault.routeFees(free + 1, 0, 0);
    }

    function test_notifyFees_zeroAmount_reverts() public {
        vm.prank(address(vault));
        vm.expectRevert("LockVaultV2: zero amount");
        lockVault.notifyFees(0);
    }
}
