// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IMintableUSDC {
    function mint(address to, uint256 amount) external;
}

/// @notice Testnet helper that drips ETH (one-shot per address) and mock USDC (24h cooldown).
///         Operationally distinct from the protocol — see docs/changes/B_SLOG_SPRINT.md.
contract OnboardingFaucet is Ownable {
    IMintableUSDC public immutable usdc;

    uint256 public ethDripAmount = 0.005 ether;
    uint256 public usdcDripAmount = 10_000e6;
    uint256 public usdcCooldown = 24 hours;

    mapping(address => bool) public ethClaimed;
    mapping(address => uint256) public lastUsdcClaim;

    event EthClaimed(address indexed user, uint256 amount);
    event UsdcClaimed(address indexed user, uint256 amount);
    event Funded(address indexed from, uint256 amount);
    event EthWithdrawn(address indexed to, uint256 amount);
    event DripParamsSet(uint256 ethDripAmount, uint256 usdcDripAmount, uint256 usdcCooldown);

    error AlreadyClaimedEth();
    error UsdcCooldownActive(uint256 nextClaimAt);
    error FaucetEmpty();
    error EthTransferFailed();

    constructor(address usdc_, address owner_) Ownable(owner_) {
        usdc = IMintableUSDC(usdc_);
    }

    function claimEth() external {
        if (ethClaimed[msg.sender]) revert AlreadyClaimedEth();
        uint256 amount = ethDripAmount;
        if (address(this).balance < amount) revert FaucetEmpty();

        ethClaimed[msg.sender] = true;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();

        emit EthClaimed(msg.sender, amount);
    }

    function claimUsdc() external {
        uint256 nextClaimAt = lastUsdcClaim[msg.sender] + usdcCooldown;
        if (block.timestamp < nextClaimAt) revert UsdcCooldownActive(nextClaimAt);

        lastUsdcClaim[msg.sender] = block.timestamp;
        usdc.mint(msg.sender, usdcDripAmount);

        emit UsdcClaimed(msg.sender, usdcDripAmount);
    }

    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function withdrawEth(uint256 amount) external onlyOwner {
        if (address(this).balance < amount) revert FaucetEmpty();

        (bool ok,) = owner().call{value: amount}("");
        if (!ok) revert EthTransferFailed();

        emit EthWithdrawn(owner(), amount);
    }

    function setDripParams(uint256 ethAmt, uint256 usdcAmt, uint256 cooldown) external onlyOwner {
        ethDripAmount = ethAmt;
        usdcDripAmount = usdcAmt;
        usdcCooldown = cooldown;
        emit DripParamsSet(ethAmt, usdcAmt, cooldown);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }
}
