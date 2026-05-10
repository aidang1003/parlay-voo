import type { Abi, Log, PublicClient } from "viem";

// `false` pins the pending discriminant — toBlock: "latest" means every log
// is mined, so blockNumber/transactionHash are bigint/`0x${string}` not null.
type MinedLog = Log<bigint, number, false>;

// Alchemy's eth_getLogs cap is 10k blocks per request on the free tier; the
// public Base Sepolia RPC (sepolia.base.org) 413's at roughly the same range.
// 9_500 leaves a tiny margin so we don't have to think about off-by-one when
// the inclusive endpoints overlap.
const DEFAULT_CHUNK_SIZE = 9_500n;

// 500k blocks ≈ 12 days of Base Sepolia at 2s blocks. The Activity tab only
// renders the most recent N events, so a hard cap keeps a quiet contract from
// scanning all the way back to genesis chunk-by-chunk.
const DEFAULT_MAX_LOOKBACK = 500_000n;

interface GetRecentEventsArgs {
  publicClient: PublicClient;
  address: `0x${string}`;
  abi: Abi;
  eventName: string;
  /** Stop scanning once this many events are collected. */
  limit: number;
  /** Override the per-request block window. */
  chunkSize?: bigint;
  /** Hard cap on total blocks to walk back. */
  maxLookback?: bigint;
}

/**
 * Walk backwards from the latest block in chunks until `limit` matching events
 * are collected (or the lookback cap / block 0 is reached). Replaces a
 * `fromBlock: 0n → toBlock: "latest"` scan that gets rejected by Alchemy
 * (>10k block window) and 413's the public Base RPC fallback.
 *
 * Returned logs are unsorted; the caller sorts and clips. Exact `limit` is a
 * lower bound — the last chunk may overshoot.
 */
export async function getRecentContractEvents({
  publicClient,
  address,
  abi,
  eventName,
  limit,
  chunkSize = DEFAULT_CHUNK_SIZE,
  maxLookback = DEFAULT_MAX_LOOKBACK,
}: GetRecentEventsArgs): Promise<MinedLog[]> {
  const latest = await publicClient.getBlockNumber();
  const floor = latest > maxLookback ? latest - maxLookback : 0n;

  const collected: MinedLog[] = [];
  let toBlock = latest;
  while (toBlock >= floor) {
    const fromBlock = toBlock > chunkSize ? toBlock - chunkSize + 1n : 0n;
    const effectiveFrom = fromBlock > floor ? fromBlock : floor;

    const logs = await publicClient.getContractEvents({
      address,
      abi,
      eventName,
      fromBlock: effectiveFrom,
      toBlock,
    });
    collected.push(...(logs as unknown as MinedLog[]));

    if (collected.length >= limit) break;
    if (effectiveFrom === 0n || effectiveFrom === floor) break;
    toBlock = effectiveFrom - 1n;
  }

  return collected;
}
