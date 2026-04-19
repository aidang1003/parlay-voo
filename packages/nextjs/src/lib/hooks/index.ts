/**
 * Barrel for wagmi-backed app hooks. Grouped by domain entity — pick the file
 * that matches what you're fetching/writing:
 *
 * - `leg.ts`    — `useLegDescriptions`, `useLegStatuses` (LegRegistry + oracle)
 * - `usdc.ts`   — `useUSDCBalance`, `useMintTestUSDC` (MockUSDC)
 * - `vault.ts`  — `useVaultStats`, `useDepositVault`, `useWithdrawVault`,
 *                 `useCreditBalance`, `useRehabClaimable`, `useClaimRehab` (HouseVault)
 * - `lock.ts`   — `useLockVault`, `useUnlockVault`, `useEarlyWithdraw`,
 *                 `useLockPositions`, `useLockStats` (LockVault)
 * - `parlay.ts` — `useParlayConfig`, `useBuyTicket` (ParlayEngine config + JIT buy)
 * - `ticket.ts` — `useTicket`, `useUserTickets`, `useAllTickets`,
 *                 `useSettleTicket`, `useClaimPayout`, `useCashoutEarly`
 *                 (ParlayEngine ticket ops)
 *
 * Internal helpers (`usePinnedChainId`, `useContractClient`, `EMPTY_ABI`) live
 * in `_internal.ts` and are intentionally not re-exported.
 */

export * from "./leg";
export * from "./usdc";
export * from "./vault";
export * from "./lock";
export * from "./parlay";
export * from "./ticket";
