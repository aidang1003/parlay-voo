// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../../src/MockUSDC.sol";
import {HouseVault} from "../../src/core/HouseVault.sol";
import {LegRegistry} from "../../src/core/LegRegistry.sol";
import {ParlayEngine} from "../../src/core/ParlayEngine.sol";
import {AdminOracleAdapter} from "../../src/oracle/AdminOracleAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeRouterSetup} from "../helpers/FeeRouterSetup.sol";

/// @notice Tests for ParlayEngine.buyTicketSigned — the EIP-712 signed-quote
///         buy path that replaces pre-registration. Covers happy-path mint,
///         signature/domain/nonce/deadline failures, sourceRef dedupe across
///         tickets, and snapshot storage.
contract SignedQuoteTest is FeeRouterSetup {
    MockUSDC usdc;
    HouseVault vault;
    LegRegistry registry;
    ParlayEngine engine;
    AdminOracleAdapter oracle;

    address owner = address(this);
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 signerPk = 0xA11CE;
    address signer;
    uint256 wrongPk = 0xB0B;

    uint256 constant BOOTSTRAP_ENDS = 1_000_000;

    function setUp() public {
        vm.warp(500_000);
        signer = vm.addr(signerPk);

        usdc = new MockUSDC();
        vault = new HouseVault(IERC20(address(usdc)));
        registry = new LegRegistry();
        oracle = new AdminOracleAdapter();
        engine = new ParlayEngine(vault, registry, IERC20(address(usdc)), BOOTSTRAP_ENDS);

        vault.setEngine(address(engine));
        registry.setEngine(address(engine));
        engine.setTrustedQuoteSigner(signer);

        _wireFeeRouter(vault);

        usdc.mint(owner, 10_000e6);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e6, owner);

        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _leg(string memory sourceRef, uint256 ppm, bytes32 outcome)
        internal
        view
        returns (ParlayEngine.SourceLeg memory)
    {
        return ParlayEngine.SourceLeg({
            sourceRef: sourceRef,
            outcome: outcome,
            probabilityPPM: ppm,
            cutoffTime: 600_000,
            earliestResolve: 700_000,
            oracleAdapter: address(oracle)
        });
    }

    function _twoLegQuote(address buyer, uint256 stake, uint256 nonce, uint256 deadline)
        internal
        view
        returns (ParlayEngine.Quote memory q)
    {
        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](2);
        legs[0] = _leg("poly:a", 500_000, bytes32(uint256(1)));
        legs[1] = _leg("poly:b", 250_000, bytes32(uint256(1)));
        q = ParlayEngine.Quote({
            buyer: buyer,
            stake: stake,
            legs: legs,
            deadline: deadline,
            nonce: nonce
        });
    }

    function _sign(uint256 pk, ParlayEngine.Quote memory q) internal view returns (bytes memory) {
        // hashQuote uses calldata; indirect through a stub that re-encodes.
        bytes32 digest = _hashQuoteMemory(q);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Mirrors ParlayEngine._hashQuote but operates on memory so tests
    ///      can build quotes without first going through calldata.
    function _hashQuoteMemory(ParlayEngine.Quote memory q) internal view returns (bytes32) {
        bytes32 sourceLegTypeHash = keccak256(
            "SourceLeg(string sourceRef,bytes32 outcome,uint256 probabilityPPM,uint256 cutoffTime,uint256 earliestResolve,address oracleAdapter)"
        );
        bytes32 quoteTypeHash = keccak256(
            "Quote(address buyer,uint256 stake,SourceLeg[] legs,uint256 deadline,uint256 nonce)SourceLeg(string sourceRef,bytes32 outcome,uint256 probabilityPPM,uint256 cutoffTime,uint256 earliestResolve,address oracleAdapter)"
        );

        bytes32[] memory legHashes = new bytes32[](q.legs.length);
        for (uint256 i = 0; i < q.legs.length; i++) {
            legHashes[i] = keccak256(
                abi.encode(
                    sourceLegTypeHash,
                    keccak256(bytes(q.legs[i].sourceRef)),
                    q.legs[i].outcome,
                    q.legs[i].probabilityPPM,
                    q.legs[i].cutoffTime,
                    q.legs[i].earliestResolve,
                    q.legs[i].oracleAdapter
                )
            );
        }
        bytes32 structHash = keccak256(
            abi.encode(
                quoteTypeHash,
                q.buyer,
                q.stake,
                keccak256(abi.encodePacked(legHashes)),
                q.deadline,
                q.nonce
            )
        );
        bytes32 separator = engine.domainSeparator();
        return keccak256(abi.encodePacked("\x19\x01", separator, structHash));
    }

    // ── Happy path ───────────────────────────────────────────────────────

    function test_buyTicketSigned_happyPath_mintsAndSnapshots() public {
        ParlayEngine.Quote memory q = _twoLegQuote(alice, 10e6, 1, 550_000);
        bytes memory sig = _sign(signerPk, q);

        vm.prank(alice);
        uint256 ticketId = engine.buyTicketSigned(q, sig);

        // Ticket recorded with expected fields
        ParlayEngine.Ticket memory t = engine.getTicket(ticketId);
        assertEq(t.buyer, alice);
        assertEq(t.stake, 10e6);
        assertEq(t.legIds.length, 2);

        // Snapshots written with the signed PPMs
        ParlayEngine.LegSnapshot[] memory snaps = engine.getTicketSnapshots(ticketId);
        assertEq(snaps.length, 2);
        assertEq(snaps[0].probabilityPPM, 500_000);
        assertEq(snaps[1].probabilityPPM, 250_000);
        assertEq(snaps[0].oracleAdapter, address(oracle));

        // Legs created in registry by the engine
        assertEq(registry.legCount(), 2);
        (uint256 idA, bool existsA) = registry.legIdBySourceRef("poly:a");
        assertTrue(existsA);
        assertEq(idA, t.legIds[0]);

        // Nonce consumed
        assertTrue(engine.usedQuoteNonces(1));
    }

    // ── Failures ─────────────────────────────────────────────────────────

    function test_buyTicketSigned_expired_reverts() public {
        ParlayEngine.Quote memory q = _twoLegQuote(alice, 10e6, 2, 400_000); // past
        bytes memory sig = _sign(signerPk, q);
        vm.prank(alice);
        vm.expectRevert(bytes("ParlayEngine: quote expired"));
        engine.buyTicketSigned(q, sig);
    }

    function test_buyTicketSigned_wrongSigner_reverts() public {
        ParlayEngine.Quote memory q = _twoLegQuote(alice, 10e6, 3, 550_000);
        bytes memory sig = _sign(wrongPk, q);
        vm.prank(alice);
        vm.expectRevert(bytes("ParlayEngine: bad signature"));
        engine.buyTicketSigned(q, sig);
    }

    function test_buyTicketSigned_tamperedPPM_reverts() public {
        ParlayEngine.Quote memory q = _twoLegQuote(alice, 10e6, 4, 550_000);
        bytes memory sig = _sign(signerPk, q);
        // Change PPM after signing — digest no longer matches
        q.legs[0].probabilityPPM = 900_000;
        vm.prank(alice);
        vm.expectRevert(bytes("ParlayEngine: bad signature"));
        engine.buyTicketSigned(q, sig);
    }

    function test_buyTicketSigned_buyerMismatch_reverts() public {
        ParlayEngine.Quote memory q = _twoLegQuote(alice, 10e6, 5, 550_000);
        bytes memory sig = _sign(signerPk, q);
        vm.prank(bob);
        vm.expectRevert(bytes("ParlayEngine: buyer mismatch"));
        engine.buyTicketSigned(q, sig);
    }

    function test_buyTicketSigned_replay_reverts() public {
        ParlayEngine.Quote memory q = _twoLegQuote(alice, 10e6, 6, 550_000);
        bytes memory sig = _sign(signerPk, q);
        vm.prank(alice);
        engine.buyTicketSigned(q, sig);

        vm.prank(alice);
        vm.expectRevert(bytes("ParlayEngine: nonce used"));
        engine.buyTicketSigned(q, sig);
    }

    function test_buyTicketSigned_signerUnset_reverts() public {
        engine.setTrustedQuoteSigner(address(0));
        ParlayEngine.Quote memory q = _twoLegQuote(alice, 10e6, 7, 550_000);
        bytes memory sig = _sign(signerPk, q);
        vm.prank(alice);
        vm.expectRevert(bytes("ParlayEngine: signer not set"));
        engine.buyTicketSigned(q, sig);
    }

    // ── Dedupe across tickets ────────────────────────────────────────────

    function test_buyTicketSigned_sameSourceRef_dedupes() public {
        // First ticket creates poly:a + poly:b
        ParlayEngine.Quote memory q1 = _twoLegQuote(alice, 10e6, 10, 550_000);
        bytes memory sig1 = _sign(signerPk, q1);
        vm.prank(alice);
        uint256 t1 = engine.buyTicketSigned(q1, sig1);

        // Second ticket reuses poly:a alongside a new poly:c
        ParlayEngine.SourceLeg[] memory legs = new ParlayEngine.SourceLeg[](2);
        legs[0] = _leg("poly:a", 500_000, bytes32(uint256(1)));
        legs[1] = _leg("poly:c", 400_000, bytes32(uint256(1)));
        ParlayEngine.Quote memory q2 = ParlayEngine.Quote({
            buyer: alice,
            stake: 10e6,
            legs: legs,
            deadline: 550_000,
            nonce: 11
        });
        bytes memory sig2 = _sign(signerPk, q2);
        vm.prank(alice);
        uint256 t2 = engine.buyTicketSigned(q2, sig2);

        // poly:a on t2 must reuse the legId assigned on t1
        ParlayEngine.Ticket memory ticket1 = engine.getTicket(t1);
        ParlayEngine.Ticket memory ticket2 = engine.getTicket(t2);
        assertEq(ticket1.legIds[0], ticket2.legIds[0], "poly:a legId must be shared");

        // Registry must have created exactly 3 legs (a, b, c), not 4
        assertEq(registry.legCount(), 3);
    }

    // ── Only engine may call getOrCreateBySourceRef ──────────────────────

    function test_getOrCreateBySourceRef_nonEngine_reverts() public {
        vm.expectRevert(bytes("LegRegistry: only engine"));
        registry.getOrCreateBySourceRef("poly:x", "poly:x", 600_000, 700_000, address(oracle), 500_000);
    }
}
