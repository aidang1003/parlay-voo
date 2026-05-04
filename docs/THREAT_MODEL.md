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

### T7: Warm Deployer Key Compromise
**Risk**: `WARM_DEPLOYER_PRIVATE_KEY` is the owner of `HouseVault`, `ParlayEngine`, `LegRegistry`, `LockVaultV2`, and `AdminOracleAdapter`. Compromise gives an attacker a complete drain path. The "warm" label is a *signal* (we store this key more carefully than the hot signer), not a security boundary — the on-chain powers are at multisig/root-key level.

**Concrete drain vectors if leaked:**
- `HouseVault.setEngine(maliciousAddr)` — vault trusts whatever engine is set. Attacker's engine calls `reservePayout` + `payOut` and walks the LP USDC out.
- `ParlayEngine.setTrustedQuoteSigner(attacker)` — attacker becomes the signer, forges arbitrary multipliers, buys tickets at rigged prices.
- `AdminOracleAdapter.resolve(legId, Won, ...)` — mark any leg WIN. Buy a ticket on those legs, claim from vault. (Testnet-only; the contract reverts on Base mainnet — there UMA is the writer.)
- `LegRegistry.addLeg / updateProbability / setLegCorrGroup` — list legs with rigged odds, or change odds on existing legs after tickets are bought.
- `setMaxUtilizationBps`, `setMaxPayoutBps` — relax the per-ticket caps that bound T9 (hot-signer compromise), expanding everything else.

**What does *not* drain on its own:**
- `pause()` doesn't help us once the attacker has the key — `pause` itself is `onlyOwner`, so the attacker can `unpause` at will. Pause is only useful for the legitimate owner before the attacker acts.
- `setLockVault`, `setSafetyModule`, `setYieldAdapter` redirect future flows but don't directly move existing assets — they're enablers for the drain vectors above, not drains themselves.

**What is structurally bounded:**
- ERC4626-style share math: an attacker can't mint LP shares without depositing, so direct LP-share inflation isn't a vector.
- Tickets are ERC721; an attacker can't transfer existing tickets out of legitimate holders' wallets.

**Mitigations (current MVP):**
- Single-admin trust model is accepted for the MVP.
- `Ownable` (not `Ownable2Step`) — no transfer confirmation today; production should switch.
- No timelock on owner setters — production should add one (e.g., 24-48h delay on `setEngine`/`setTrustedQuoteSigner`/`set*Bps`).
- No self-destruct, no proxy upgrades. Drain is bounded to current TVL; deployed code can't be replaced without a fresh deploy + migration.

**Recovery runbook (if compromised):**
1. **Race the attacker:** if you still control the key, immediately `pause()` `HouseVault` and `ParlayEngine`. This freezes deposits, withdrawals, ticket buys, and settlements.
2. **If you've lost the key:** you can't `pause` from a hostile state. Contact LPs immediately (Discord, on-chain message) and tell them to call `withdraw` on `HouseVault` while it still has assets. The `withdraw` path goes through the legitimate engine; until the attacker calls `setEngine`, withdrawals work.
3. **Post-incident:** redeploy the protocol from a fresh key (no proxy upgrade path exists). Migrate LP positions by snapshotting `HouseVault.balanceOf` at the freeze block and seeding the new vault. Tickets bought before the freeze are paid out from the legacy contracts to whatever USDC remains.

**Production path (out of MVP scope):**
- Multisig (Safe) as `owner`. M-of-N threshold; key compromise of one signer is not protocol compromise.
- Timelock on every owner setter (`setEngine`, `setTrustedQuoteSigner`, `setMaxUtilizationBps`, `setMaxPayoutBps`, `setProtocolFeeBps`). 24h minimum.
- `Ownable2Step` so accidental ownership transfer to a wrong address can't brick the protocol.
- Compromise-detection feature (see backlog) — auto-pause on hostile owner-call patterns.

### T8: Denial of Service
**Risk**: Attacker buys many small tickets to exhaust vault capacity.
**Mitigations**:
- `minStake` enforced (1 USDC)
- Gas cost on Base discourages spam
- Admin can pause if needed

### T9: Hot Signer Key Compromise
**Risk**: `HOT_SIGNER_PRIVATE_KEY` leaks. The signer's only on-chain power is producing EIP-712 quotes the engine accepts. Attacker forges quotes with rigged multipliers, buys tickets, claims winnings from the vault.

**What's bounded by design:**
- Hot key is **not** an `onlyOwner` of any contract. It cannot pause, change parameters, add legs, or resolve oracle outcomes. It cannot rotate itself either — only the warm deployer can.
- Per-ticket loss is capped by `maxPayoutBps` (5% TVL) on the vault side and quote `expiry` + `nonce` on the engine side (no replay).
- Per-wave loss is capped by `maxUtilizationBps` (80% TVL): once 80% of vault is reserved across all in-flight tickets, new buys revert until earlier tickets settle or cash out.

**Damage formula (worst case):**
```
loss ≈ (maxPayoutBps × TVL) × (tickets attacker fires before warm key rotates the signer)
```
With current params on a $100k vault: $5k per ticket × N tickets, capped at $80k total reserved. Real-world N depends on your detection latency (minutes-to-hours for manual rotation).

**Mitigations (current MVP):**
- Hot key is dedicated; rotation is one call (`ParlayEngine.setTrustedQuoteSigner`) using the warm key, no redeploy.
- Quotes carry an EIP-712 `expiry` (short, server-clock enforced) and a `nonce`. Replay protection is per-`nonce`, so an attacker can't reuse a single forged quote.
- Engine caps survive signature validation — see "What's bounded" above.

**Recovery runbook:**
1. Pause `ParlayEngine` from the warm key (`pause()`). Freezes ticket buys.
2. Rotate the hot signer: `setTrustedQuoteSigner(newSignerAddr)`. Generate the new key on a separate machine; never touch the old one again.
3. Unpause. Existing in-flight tickets settle normally; the attacker's tickets that were bought with forged quotes will pay out per their (rigged) terms — that's already-realized loss.
4. Audit: pull all tickets bought with the compromised signer's address; quantify total reserved + paid out; account for losses in next vault accounting cycle.

**Production path:**
- Move signer to an HSM (AWS KMS, Turnkey, Fireblocks). Key never lives in env vars or process memory.
- Compromise-detection feature (see backlog) — automatic pause + signer rotation on anomalous quote patterns.

### T10: Cron Compromise
**Risk**: `CRON_SECRET` leaks. Attacker calls `/api/polymarket/sync` or `/api/settlement/run` to force a resolution state or trigger settlement on picked tickets.
**Mitigations**:
- `/api/settlement/run` is safe-by-construction: it only calls `settleTicket` for legs whose oracle already returned `canResolve=true`. An attacker invoking it early just wastes gas.
- `/api/polymarket/sync` relays outcomes verbatim from Polymarket. An attacker cannot choose an outcome — they can only trigger the relay earlier than scheduled. Phase B is idempotent (`tbpolymarketresolution` primary key is the gate).
- Resolution writes are signed by `WARM_DEPLOYER_PRIVATE_KEY`, so a cron-secret leak does not by itself authorize on-chain writes — the leaked endpoint must also reach a server with the signing key.
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
