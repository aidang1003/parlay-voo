# ParlayCity Threat Model

## Assets at Risk

| Asset | Location | Value |
|-------|----------|-------|
| LP deposits (USDC) | HouseVault | High |
| Ticket payouts | HouseVault (reserved) | High |
| Oracle integrity | OracleAdapters | High |
| Asserter/disputer bonds | UmaOracleAdapter (forwarded to UMA OOv3) | Medium |
| Admin keys | Deployer EOA | Critical |
| JIT quote signer key | Hot EOA on Vercel | High |
| Cron secret | Vercel env | Medium |
| DB credentials | Neon Postgres | Medium |

## Threat Categories

### T1: Vault Insolvency
**Risk**: Payouts exceed vault assets.
**Mitigations**:
- `maxPayoutBps` caps single ticket payout at 5% TVL
- `maxUtilizationBps` caps total reserved at 80% of assets
- Utilization check at ticket purchase time
- Reserved amount tracked and enforced

### T2: Oracle Manipulation (AdminOracleAdapter, testnet)
**Risk**: Admin resolves legs dishonestly.
**Mitigations**:
- `AdminOracleAdapter.resolve()` reverts on Base mainnet (`require(block.chainid != 8453)`) — unreachable in production.
- Restricted to Anvil + Base Sepolia for dev/QA. Admin key is disclosed as centralized trust on testnet only.
- Mainnet replacement is `UmaOracleAdapter` (T3).

### T3: Oracle Manipulation (UmaOracleAdapter, mainnet)
**Risk**: Asserter submits false outcome, no one disputes; or UMA DVM is corrupted.
**Mitigations**:
- Asserter posts a bond (USDC) into UMA OOv3 via `assertTruth`.
- Liveness window (default 7200s on Base; tunable via `setLiveness`) — anyone can dispute by matching the bond.
- Disputed assertions escalate to UMA's DVM (token-holder vote on Ethereum mainnet, ~2 days). Loser's bond is slashed.
- The **only** writer to `_finalStatus` / `_finalOutcome` / `_isFinalized` is `assertionResolvedCallback`, gated by `msg.sender == address(uma)`. No `onlyOwner` function in the oracle path can mutate outcome state. Verified by unit test `test_adminSetters_cannotWriteOutcomeState`.
- Bond is refundable on truthful settlement (minus UMA's final fee), so capital recirculates rather than being a per-resolution cost.

### T4: Reentrancy
**Risk**: Callback during token transfer drains funds.
**Mitigations**:
- ReentrancyGuard on all state-changing externals
- Checks-effects-interactions pattern
- SafeERC20 (no callback tokens in USDC, but defense in depth)

### T5: Integer Overflow / Precision Loss
**Risk**: Multiplier computation overflows or loses precision.
**Mitigations**:
- Solidity 0.8+ built-in overflow checks
- PPM (1e6) for probabilities, consistent scaling
- Fuzz tests covering edge cases

### T6: Front-running
**Risk**: Attacker sees ticket purchase, manipulates probability.
**Mitigations**:
- Probability is admin-set, not market-derived in MVP
- Future: EIP-712 signed quotes with expiry
- Base L2 has 2s blocks and sequencer ordering (less MEV surface)

### T7: Admin Key Compromise
**Risk**: Deployer key stolen, contracts drained/paused maliciously.
**Mitigations**:
- Hackathon accepts single-admin trust model
- Production path: multisig (Safe), timelock, governance
- Pausable as emergency brake
- No self-destruct, no proxy upgrades in MVP

### T8: Denial of Service
**Risk**: Attacker buys many small tickets to exhaust vault capacity.
**Mitigations**:
- `minStake` enforced (1 USDC)
- Gas cost on Base discourages spam
- Admin can pause if needed

### T9: JIT Quote Signer Compromise
**Risk**: `QUOTE_SIGNER_PRIVATE_KEY` leaks. Attacker forges signed quotes that understate edge or overstate multiplier, letting them drain vault on ticket settlement.
**Mitigations**:
- Quote signer is a dedicated hot key, **not** the deployer. Rotation = `SetTrustedSigner` call with a new address; no redeploy required.
- Every quote carries an EIP-712 `expiry` (short, server-clock enforced) and a `nonce`; the engine rejects expired or replayed quotes.
- Engine caps still apply after signature validation: `maxPayoutBps` (5% TVL) and `maxUtilizationBps` (80% TVL) bound loss per ticket and per wave of attacks.
- Operator runbook: pause `ParlayEngine`, rotate signer, resume. Pause window is seconds.
- Production path: signer behind an AWS KMS / Turnkey-style HSM so the key never lives in env vars.

### T10: Cron Compromise
**Risk**: `CRON_SECRET` leaks. Attacker calls `/api/polymarket/sync` or `/api/settlement/run` to force a resolution state or trigger settlement on picked tickets.
**Mitigations**:
- `/api/settlement/run` is safe-by-construction: it only calls `settleTicket` for legs whose oracle already returned `canResolve=true`. An attacker invoking it early just wastes gas.
- `/api/polymarket/sync` relays outcomes verbatim from Polymarket. An attacker cannot choose an outcome — they can only trigger the relay earlier than scheduled. Phase B is idempotent (`tbpolymarketresolution` primary key is the gate).
- Resolution writes are signed by `DEPLOYER_PRIVATE_KEY`, so a cron-secret leak does not by itself authorize on-chain writes — the leaked endpoint must also reach a server with the signing key.
- Rotate `CRON_SECRET` via `vercel env` without redeploy.

### T11: Polymarket Data Integrity
**Risk**: Polymarket API returns stale or manipulated odds at registration, or a UMA-disputed outcome is relayed as final.
**Mitigations**:
- Every curated entry is PR-gated; no automatic market discovery.
- `earliestResolve` and 1h-past-cutoff buffer give UMA disputes time to surface before Phase B fires.
- Ambiguous `outcome_prices` (anything other than `[1,0]`, `[0,1]`, or an empty array on a closed market) returns null and retries next tick.
- Manual void path documented in [POLYMARKET.md](POLYMARKET.md) — admin can call `AdminOracleAdapter.resolve(legId, VOIDED, 0x0)` directly and block future sync attempts for that condition.

## Known Limitations (Hackathon Scope)

1. Single admin key (not multisig)
2. AdminOracleAdapter remains deployed on testnets (mainnet `resolve()` reverts; testnet path is owner-arbitrated)
3. No timelock on admin actions
4. No formal verification
5. Probability feeds are manual (not from live oracles)
6. No MEV protection beyond L2 ordering
