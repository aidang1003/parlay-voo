// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ParlayEngine} from "../../src/core/ParlayEngine.sol";

/// @notice Shared test helper for building + signing EIP-712 Quotes and buying
///         tickets through ParlayEngine.buyTicketSigned. Maintains a per-test
///         auto-increment nonce so individual tests don't have to manage one.
abstract contract SignedBuy is Test {
    /// @dev Auto-incrementing nonce used by `_buySignedYes` and friends.
    uint256 internal _nextQuoteNonce = 1;

    /// @dev Default EIP-712 signer PK. Tests that need a wrong-signer case
    ///      should sign with their own PK via `_signQuote`.
    uint256 internal constant SIGNER_PK = 0xA11CE;

    function _signerAddr() internal pure returns (address) {
        return vm.addr(SIGNER_PK);
    }

    // ── Quote builders ───────────────────────────────────────────────────

    function _mkLeg(string memory sourceRef, bytes32 outcome, uint256 ppm, address oracleAdapter, uint256 cutoffTime, uint256 earliestResolve)
        internal
        pure
        returns (ParlayEngine.SourceLeg memory)
    {
        return ParlayEngine.SourceLeg({
            sourceRef: sourceRef,
            outcome: outcome,
            probabilityPPM: ppm,
            cutoffTime: cutoffTime,
            earliestResolve: earliestResolve,
            oracleAdapter: oracleAdapter
        });
    }

    function _mkQuote(address buyer, uint256 stake, ParlayEngine.SourceLeg[] memory legs, uint256 deadline, uint256 nonce)
        internal
        pure
        returns (ParlayEngine.Quote memory q)
    {
        q = ParlayEngine.Quote({buyer: buyer, stake: stake, legs: legs, deadline: deadline, nonce: nonce});
    }

    // ── EIP-712 hashing (memory-based, mirrors ParlayEngine._hashQuote) ──

    function _hashQuoteMemory(ParlayEngine engine, ParlayEngine.Quote memory q) internal view returns (bytes32) {
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
            abi.encode(quoteTypeHash, q.buyer, q.stake, keccak256(abi.encodePacked(legHashes)), q.deadline, q.nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", engine.domainSeparator(), structHash));
    }

    function _signQuote(ParlayEngine engine, uint256 pk, ParlayEngine.Quote memory q)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = _hashQuoteMemory(engine, q);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── High-level helpers ───────────────────────────────────────────────

    /// @dev Build + sign + call buyTicketSigned. Caller must have already
    ///      pranked buyer (or we prank here). Returns ticketId.
    function _buySigned(
        ParlayEngine engine,
        address buyer,
        ParlayEngine.SourceLeg[] memory legs,
        uint256 stake,
        uint256 deadline
    ) internal returns (uint256 ticketId) {
        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(buyer, stake, legs, deadline, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);
        vm.prank(buyer);
        ticketId = engine.buyTicketSigned(q, sig);
    }

    /// @dev Build + sign + call buyLosslessParlay.
    function _buyLossless(
        ParlayEngine engine,
        address buyer,
        ParlayEngine.SourceLeg[] memory legs,
        uint256 stake,
        uint256 deadline
    ) internal returns (uint256 ticketId) {
        uint256 nonce = _nextQuoteNonce++;
        ParlayEngine.Quote memory q = _mkQuote(buyer, stake, legs, deadline, nonce);
        bytes memory sig = _signQuote(engine, SIGNER_PK, q);
        vm.prank(buyer);
        ticketId = engine.buyLosslessParlay(q, sig);
    }
}
