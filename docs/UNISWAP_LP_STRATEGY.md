# Uniswap V3 LP Yield Strategy

*LLM spec: [llm-spec/UNISWAP_LP_STRATEGY.md](llm-spec/UNISWAP_LP_STRATEGY.md)*

**Status:** Planned. No adapter deployed yet; default yield sink remains `MockYieldAdapter` locally and `AaveYieldAdapter` is the real-chain slot.

How ParlayVoo intends to deploy idle vault capital (and rehab-mode locked principal) into concentrated Uniswap V3 LP positions on Base.

## Motivation

Two pools of USDC earn nothing today:

1. **HouseVault idle capital** — USDC sitting in the vault above the `yieldBufferBps` (25%) threshold and `totalReserved` floor.
2. **Rehab-mode locked principal** — losing stakes locked as user principal. The capital stays in the vault; yield on it backs the projected-APR credit advances (see `REHAB_MODE.md`).

Uniswap V3 stable-stable concentrated LP turns this idle USDC into swap-fee income without meaningful capital risk. The yield flows back to the vault (raises share price), plus a slice of future fees earmarks the SafetyModule if/when that ships.

## Pair selection

### Why USDC/USDS, not USDC/BOLD

BOLD (Liquity V2's stablecoin) is Ethereum-mainnet only. No canonical BOLD on Base. Bridged BOLD introduces bridge risk and thin liquidity. Rejected.

### The choice: USDC/USDS on the 0.05% tier

| Pair | Fee tier | IL risk | Liquidity on Base | Verdict |
|---|---|---|---|---|
| **USDC/USDS** | 0.05% (5 bps) | Minimal (~0.03%) | Deep (MakerDAO/Sky) | **Primary** |
| USDC/USDbC | 0.01% (1 bp) | Near-zero | Declining (legacy) | Backup |
| USDC/USDT | 0.05% (5 bps) | Minimal | Moderate on Base | Alternative |

- Both USDC and USDS are dollar-pegged stables with strong backing (Circle + Sky/MakerDAO).
- USDS is over-collateralized (>150%) — lower depeg risk than algorithmic stables.
- 0.05% is the standard stable-stable tier on Uniswap V3.
- A tight range of `[0.998, 1.002]` captures >99% of trading volume.
- Capital efficiency on stables: ~2000× vs V2 for a 40-pip range.
- Deep liquidity on Base via Spark Liquidity Layer ($500M+ USDC deployed on Base).

## IL / fee math

For a USDC/USDS pair in the [0.998, 1.002] range:

```
Price stays in range (>99% of time):
  IL = 0.00% to 0.03%
  Fee income at 0.05% tier with $1M TVL and $50M daily volume:
    Daily fees = $50M * 0.05% * (our_liquidity / total_liquidity)
    Annualized: 5–15% APR depending on our share of liquidity

Price exits range (rare depeg):
  Position becomes 100% one-sided (all USDC or all USDS)
  Capital safe, stops earning fees
  Re-range when price returns, or withdraw if depeg is permanent
```

For context, Aave V3 on Base yields 2–5% APR on USDC. This strategy targets 5–15% APR with marginally higher complexity but still minimal capital risk.

## Depeg scenario

If USDS depegs to $0.95 (severe but temporary — e.g., March 2023 USDC depeg):
- Position becomes 100% USDS, 0% USDC.
- Paper loss ~2.5% on deployed capital.
- Action: hold and collect fees as arbitrageurs trade the pair back to peg.
- Emergency: call `emergencyWithdraw()` to pull all capital back to the vault.

Historical stablecoin depegs have been short-lived (hours to days) for major stables. The `emergencyWithdraw` path ensures the vault can always recall capital.

## Adapter design at a glance

- **One LP position, not many.** On each `deploy()`, `increaseLiquidity()` on the existing NFT. Simpler accounting, lower gas.
- **50/50 swap on deploy.** Vault sends USDC; adapter swaps half to USDS through the same pool's router, then adds both sides. Swap cost (0.05% on half = 0.025% total) is acceptable against a 5–15% APR target.
- **Fixed range, manual re-range.** Range `[0.998, 1.002]` is set at construction. Persistent out-of-range triggers a manual `reRange()` call. Infrequent operation.
- **Fees don't auto-compound.** Uniswap V3 requires a `collect()` call. The adapter collects fees on every `withdraw()` and on a periodic `harvestFees()`.

## Integration with HouseVault

**Zero HouseVault changes required.** The vault already exposes:

```solidity
function setYieldAdapter(IYieldAdapter _adapter) external onlyOwner;
function deployIdle(uint256 amount) external onlyOwner;
function recallFromAdapter(uint256 amount) external onlyOwner;
function emergencyRecall() external onlyOwner;
function safeDeployable() public view returns (uint256);
```

To switch:
```solidity
vault.setYieldAdapter(uniswapAdapter);
vault.deployIdle(vault.safeDeployable());
```

## Rehab-mode interaction

Rehab mode (`docs/REHAB_MODE.md`) force-locks 100% of every losing parlay stake as VOO shares held on behalf of the loser. The stake never leaves the vault — it just gets reclassified as Least-tier locked capital.

```
Gambler loses $100 stake
  ├─ $100 stays in vault (backs locked VOO assigned to the loser)
  └─ user gets ~$6 bet-only credit (one year of projected yield, forfeit if unused)
```

Least-tier backing VOO isn't separately deployed — it earns yield through the vault's `IYieldAdapter`. Unused credit forfeits back to the vault; expired Least-tier positions burn, which accrues share price to surviving LPs.

## Future: multi-adapter routing

The current `IYieldAdapter` is a single-adapter slot. A future `YieldRouter` could split capital:

```
HouseVault → YieldRouter (implements IYieldAdapter)
                 ├─ 60% → AaveYieldAdapter (low risk, ~3% APR)
                 ├─ 30% → UniswapYieldAdapter (medium risk, ~10% APR)
                 └─ 10% → buffer (instant liquidity)
```

Post-hackathon. Single adapter is sufficient for the MVP.

## Risk matrix

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| USDS depeg (>2%) | Low | Medium | `emergencyWithdraw`, re-range |
| Uniswap V3 contract bug | Very low | High | `emergencyWithdraw`; audited core |
| Out-of-range (no fee income) | Low | Low | Monitor; re-range if persistent |
| Swap slippage on deploy/withdraw | Low | Low | `amountOutMinimum` with 0.5% tolerance |
| totalReserved spike needs recall | Medium | Medium | `safeDeployable` check; `emergencyRecall` |
| Gas cost of LP ops | N/A on Base | N/A | L2 gas is negligible |

## Sources

- [Uniswap V3 Concentrated Liquidity Docs](https://docs.uniswap.org/concepts/protocol/concentrated-liquidity)
- [Uniswap V3 LP Position Management](https://docs.uniswap.org/sdk/v3/guides/liquidity/position-data)
- [Concentrated Liquidity Capital Efficiency (Cyfrin)](https://www.cyfrin.io/blog/uniswap-v3-concentrated-liquidity-capital-efficiency)
- [USDC on Base: Liquidity & Integration](https://stablecoinflows.com/2025/10/16/why-usdc-is-the-backbone-of-base-liquidity-integration-and-on-chain-utility-explained/)
