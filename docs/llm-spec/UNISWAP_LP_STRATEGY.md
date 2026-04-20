# Uniswap V3 LP Yield Strategy — LLM spec

*Human doc: [../UNISWAP_LP_STRATEGY.md](../UNISWAP_LP_STRATEGY.md)*

**Status:** Planned. Not yet implemented.

## Contract skeleton

```solidity
contract UniswapYieldAdapter is IYieldAdapter, Ownable {
    // Immutables
    INonfungiblePositionManager public immutable nfpm;
    ISwapRouter                 public immutable router;
    IERC20                      public immutable usdc;
    IERC20                      public immutable usds;
    address                     public immutable vault;

    // State
    uint256 public positionTokenId;    // NFT ID of current LP position (0 = none)
    int24   public tickLower;
    int24   public tickUpper;
    uint24  public constant POOL_FEE = 500;   // 0.05% fee tier

    // Accounting
    uint256 public totalDeployed;      // USDC principal deployed (excludes yield)
}
```

## Interface (`IYieldAdapter`)

```solidity
function deploy(uint256 amount) external onlyVault;
function withdraw(uint256 amount) external onlyVault;
function balance() external view returns (uint256);
function emergencyWithdraw() external onlyVault;
```

## Access control

| Function | Caller |
|---|---|
| `deploy`, `withdraw`, `emergencyWithdraw` | `vault` only |
| `reRange(int24 newLower, int24 newUpper)` | `onlyOwner` |
| `harvestFees()` | permissionless |
| `setSlippageBps(uint256)` | `onlyOwner` |

## Flows

**Deploy:**
```
usdc.safeTransferFrom(vault, this, amount)
half = amount / 2
usdc.approve(router, half)
usdsOut = router.exactInputSingle(USDC → USDS, half, minOut = half * 995/1000)
usdc.approve(nfpm, amount - half)
usds.approve(nfpm, usdsOut)
if positionTokenId == 0:
  (positionTokenId, ...) = nfpm.mint(MintParams{tickLower, tickUpper, ...})
else:
  nfpm.increaseLiquidity(IncreaseLiquidityParams{tokenId: positionTokenId, ...})
totalDeployed += amount
```

**Withdraw:**
```
_collectFees()
liquidity = _positionLiquidity()
toRemove  = liquidity * amount / totalDeployed
(amount0, amount1) = nfpm.decreaseLiquidity(DecreaseLiquidityParams{...})
nfpm.collect(CollectParams{...})
if usds.balanceOf(this) > 0:
  router.exactInputSingle(USDS → USDC, usdsBalance, minOut = usdsBalance * 995/1000)
usdc.safeTransfer(vault, usdc.balanceOf(this))
totalDeployed = totalDeployed > amount ? totalDeployed - amount : 0
```

**balance():**
```
positionTokenId == 0 → 0
else                 → totalDeployed + _estimatedUnclaimedFees()
```

**emergencyWithdraw:**
```
if positionTokenId == 0: return
liquidity = _positionLiquidity()
nfpm.decreaseLiquidity(full)
nfpm.collect(full)
swap all usds → usdc
usdc.safeTransfer(vault, usdc.balanceOf(this))
positionTokenId = 0
totalDeployed   = 0
```

## Base mainnet addresses

```
NonfungiblePositionManager : 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1
SwapRouter02               : 0x2626664c2603336E57B271c5C0b26F421741e481
USDC (native)              : 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
USDS                       : <verify current Base deployment>
```

## Constants / defaults

```
POOL_FEE           uint24  500            // 0.05% tier
tickLower          int24   ~= 1.0000 - 20 bps
tickUpper          int24   ~= 1.0000 + 20 bps
slippageBps        uint16  50             // 0.5% swap slippage tolerance
minDeploy          uint256 1e6            // $1 USDC (skip dust)
```

## Invariants

1. `positionTokenId != 0` ⇔ `totalDeployed > 0` (modulo fee-only residual).
2. `usdc.balanceOf(this) == 0` immediately after any `deploy` or `withdraw` returns.
3. `usds.balanceOf(this) == 0` immediately after any `withdraw` returns (all swapped back).
4. Only `vault` can move funds out via `deploy` / `withdraw` / `emergencyWithdraw`.
5. `reRange` never takes capital out of the vault's economic view — it burns + mints without `safeTransfer` to external addresses.
6. `emergencyWithdraw` is idempotent when `positionTokenId == 0`.

## Tests required

- Unit: `deploy` / `withdraw` / `balance` round-trip matches within rounding.
- Unit: `emergencyWithdraw` recovers all capital in one call.
- Unit: slippage protection reverts when pool is manipulated to fail `amountOutMinimum`.
- Unit: `reRange` correctly burns and mints a new position.
- Unit: `harvestFees` collects and sends USDC (post-swap) to the vault.
- Integration: `HouseVault.setYieldAdapter(uniswap)` followed by `deployIdle` + `recallFromAdapter` round-trips capital.
- Fork tests on Base mainnet (Foundry `--fork-url`) against real Uniswap V3 contracts.

## Mock adapter

Parallel file `MockUniswapAdapter.sol` implements the same `IYieldAdapter` without real Uniswap calls — simulates yield accrual for local testing. Same shape as existing `MockYieldAdapter.sol`.

## Deploy integration

Add to `packages/foundry/script/Deploy.s.sol` via `steps/YieldStep.sol`:

```solidity
if (block.chainid == 8453 /* Base mainnet */) {
    adapter = new UniswapYieldAdapter(nfpm, router, usdc, usds, vault, tickLower, tickUpper);
} else if (block.chainid == 84532 /* Base Sepolia */) {
    adapter = new MockYieldAdapter(vault);
} else {
    adapter = new MockYieldAdapter(vault);
}
vault.setYieldAdapter(adapter);
```

## Files to create

```
packages/foundry/src/yield/UniswapYieldAdapter.sol
packages/foundry/src/yield/MockUniswapAdapter.sol
packages/foundry/test/unit/UniswapYieldAdapter.t.sol
packages/foundry/test/fork/UniswapYieldAdapter.fork.t.sol
packages/foundry/script/steps/YieldStep.sol                  (update to branch by chainId)
packages/nextjs/src/components/VaultDashboard.tsx            (display yield source + estimated APR)
```
