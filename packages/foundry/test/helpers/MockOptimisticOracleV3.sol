// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    IOptimisticOracleV3,
    IOptimisticOracleV3CallbackRecipient
} from "../../src/interfaces/IOptimisticOracleV3.sol";

/// @notice Minimal UMA OOv3 stand-in for unit tests. Lets a test drive the
///         callback path deterministically without depending on UMA's real
///         liveness / dispute flow (covered separately in fork tests).
contract MockOptimisticOracleV3 is IOptimisticOracleV3 {
    using SafeERC20 for IERC20;

    bytes32 public constant DEFAULT_IDENTIFIER = keccak256("ASSERT_TRUTH");

    struct StoredAssertion {
        address asserter;
        address callbackRecipient;
        IERC20 currency;
        uint256 bond;
        bool settled;
        bool truthful;
        bool disputed;
    }

    mapping(bytes32 => StoredAssertion) public assertions;
    mapping(address => uint256) public minBondByCurrency;
    uint256 public nextId;

    function setMinimumBond(address currency, uint256 amount) external {
        minBondByCurrency[currency] = amount;
    }

    function assertTruth(
        bytes memory, /* claim */
        address asserter,
        address callbackRecipient,
        address, /* escalationManager */
        uint64, /* liveness */
        IERC20 currency,
        uint256 bond,
        bytes32, /* identifier */
        bytes32 /* domainId */
    ) external override returns (bytes32 assertionId) {
        currency.safeTransferFrom(msg.sender, address(this), bond);
        assertionId = bytes32(++nextId);
        assertions[assertionId] = StoredAssertion({
            asserter: asserter,
            callbackRecipient: callbackRecipient,
            currency: currency,
            bond: bond,
            settled: false,
            truthful: false,
            disputed: false
        });
    }

    /// @dev Test hook: simulate liveness expiry + truthful settlement.
    function mockSettle(bytes32 assertionId, bool truthful) external {
        StoredAssertion storage a = assertions[assertionId];
        require(!a.settled, "mock: already settled");
        a.settled = true;
        a.truthful = truthful;

        if (truthful) {
            a.currency.safeTransfer(a.asserter, a.bond);
        }

        IOptimisticOracleV3CallbackRecipient(a.callbackRecipient).assertionResolvedCallback(assertionId, truthful);
    }

    /// @dev Test hook: simulate a disputer opening a challenge.
    function mockDispute(bytes32 assertionId) external {
        StoredAssertion storage a = assertions[assertionId];
        require(!a.settled, "mock: already settled");
        a.disputed = true;
        IOptimisticOracleV3CallbackRecipient(a.callbackRecipient).assertionDisputedCallback(assertionId);
    }

    function settleAssertion(bytes32) external pure override {
        revert("mock: use mockSettle");
    }

    function disputeAssertion(bytes32, address) external pure override {
        revert("mock: use mockDispute");
    }

    function getMinimumBond(address currency) external view override returns (uint256) {
        return minBondByCurrency[currency];
    }

    function defaultIdentifier() external pure override returns (bytes32) {
        return DEFAULT_IDENTIFIER;
    }

    function getAssertionResult(bytes32 assertionId) external view override returns (bool) {
        StoredAssertion storage a = assertions[assertionId];
        require(a.settled, "mock: not settled");
        return a.truthful;
    }
}
