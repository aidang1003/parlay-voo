// Phase A: relay Polymarket resolutions on-chain (Admin → resolve(); UMA → assert + later settleMature).
// Phase B: settleTicket() any active ticket whose legs are all resolvable.
// Idempotent via tbpolymarketresolution + on-chain assertionByLeg + already-settled ticket skip.
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  parseAbi,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry, baseSepolia, base } from "viem/chains";
import {
  ANVIL_ACCOUNT_0_KEY,
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  LOCAL_CHAIN_ID,
  getRpcUrl,
  type SupportedChainId,
} from "@parlayvoo/shared";
import { PolymarketClient } from "@/lib/polymarket/client";
import {
  getUnresolvedPolymarketLegs,
  recordResolution,
  type MarketRow,
} from "@/lib/db/client";
import deployedContracts from "@/contracts/deployedContracts";
import { encodeClaim, type ClaimOutcome } from "@/lib/uma/claim";
import { TicketStatus, mapResolution } from "./run/lib";

const ADMIN_ORACLE_ABI = parseAbi([
  "function resolve(uint256 legId, uint8 status, bytes32 outcome)",
  "function canResolve(uint256 legId) view returns (bool)",
]);

const UMA_ORACLE_ABI = parseAbi([
  "function assertOutcome(uint256 legId, uint8 status, bytes32 outcome, bytes claim) returns (bytes32)",
  "function settleMature(uint256 legId)",
  "function assertionByLeg(uint256 legId) view returns (bytes32)",
  "function canResolve(uint256 legId) view returns (bool)",
]);

const REGISTRY_ABI = parseAbi([
  "function legIdBySourceRef(string sourceRef) view returns (uint256 legId, bool exists)",
  "function getLeg(uint256 legId) view returns ((string question, string sourceRef, uint256 cutoffTime, uint256 earliestResolve, address oracleAdapter, uint256 probabilityPPM, bool active))",
]);

const ORACLE_READ_ABI = parseAbi([
  "function canResolve(uint256 legId) view returns (bool)",
]);

const ENGINE_ABI = parseAbi([
  "function ticketCount() view returns (uint256)",
  "function getTicket(uint256 ticketId) view returns ((address buyer, uint256 stake, uint256[] legIds, bytes32[] outcomes, uint256 multiplierX1e6, uint256 potentialPayout, uint256 feePaid, uint8 mode, uint8 status, uint256 createdAt, uint8 payoutMode, uint256 claimedAmount, uint256 cashoutPenaltyBps))",
  "function settleTicket(uint256 ticketId)",
]);

type ChainContracts = {
  AdminOracleAdapter: { address: `0x${string}` };
  UmaOracleAdapter?: { address: `0x${string}` };
  LegRegistry: { address: `0x${string}` };
  ParlayEngine: { address: `0x${string}` };
};

export interface SettlementResult {
  resolved: number;
  settled: number;
  skipped: number;
  errors: string[];
}

function resolveChainSetup() {
  const chainId = Number(
    process.env.NEXT_PUBLIC_CHAIN_ID ?? String(BASE_SEPOLIA_CHAIN_ID),
  ) as SupportedChainId;

  const rpcUrl = process.env.RPC_URL ?? getRpcUrl(chainId);

  let chain: Chain;
  if (chainId === LOCAL_CHAIN_ID) chain = foundry;
  else if (chainId === BASE_SEPOLIA_CHAIN_ID) chain = baseSepolia;
  else if (chainId === BASE_MAINNET_CHAIN_ID) chain = base;
  else throw new Error(`Unsupported chainId ${chainId}`);

  const entry = (deployedContracts as Record<number, Record<string, { address: `0x${string}` }>>)[
    chainId
  ];
  if (!entry) throw new Error(`No deployed contracts for chainId ${chainId}`);
  const contracts = entry as ChainContracts;

  const pk = (process.env.DEPLOYER_PRIVATE_KEY ??
    (chainId === LOCAL_CHAIN_ID ? ANVIL_ACCOUNT_0_KEY : undefined)) as Hex | undefined;
  if (!pk) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY not set (required on non-local chains to sign AdminOracleAdapter.resolve + settleTicket)",
    );
  }

  return { chainId, rpcUrl, chain, contracts, pk };
}

export async function runSettlement(): Promise<SettlementResult> {
  const cfg = resolveChainSetup();
  const account = privateKeyToAccount(cfg.pk);
  const publicClient = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
  const walletClient = createWalletClient({
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
    account,
  });

  const poly = new PolymarketClient({
    gammaUrl: process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com",
    clobUrl: process.env.POLYMARKET_CLOB_URL ?? "https://clob.polymarket.com",
  });

  const phaseA = await resolveLegs(publicClient, walletClient, cfg.contracts, poly);
  const phaseB = await settleTickets(publicClient, walletClient, cfg.contracts);

  return {
    resolved: phaseA.resolved,
    settled: phaseB.settled,
    skipped: phaseA.skipped,
    errors: [...phaseA.errors, ...phaseB.errors],
  };
}

interface PhaseAResult {
  resolved: number;
  skipped: number;
  errors: string[];
}

async function resolveLegs(
  publicClient: PublicClient,
  walletClient: WalletClient,
  contracts: ChainContracts,
  poly: PolymarketClient,
): Promise<PhaseAResult> {
  const out: PhaseAResult = { resolved: 0, skipped: 0, errors: [] };

  let rows: MarketRow[];
  try {
    rows = await getUnresolvedPolymarketLegs();
  } catch (e) {
    out.errors.push(`db: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }

  const umaAddr = contracts.UmaOracleAdapter?.address.toLowerCase();
  const adminAddr = contracts.AdminOracleAdapter.address.toLowerCase();

  for (const row of rows) {
    const conditionId = row.txtsourceref;

    try {
      const resolution = await poly.fetchResolution(conditionId);
      if (!resolution) {
        out.skipped++;
        continue;
      }

      const [legId, exists] = (await publicClient.readContract({
        address: contracts.LegRegistry.address,
        abi: REGISTRY_ABI,
        functionName: "legIdBySourceRef",
        args: [row.txtsourceref],
      })) as readonly [bigint, boolean];

      if (!exists) {
        out.skipped++;
        continue;
      }

      // Which oracle does this leg actually point at? Snapshot at registration time.
      const leg = (await publicClient.readContract({
        address: contracts.LegRegistry.address,
        abi: REGISTRY_ABI,
        functionName: "getLeg",
        args: [legId],
      })) as { oracleAdapter: `0x${string}` };
      const legAdapter = leg.oracleAdapter.toLowerCase();

      const { status, outcome } = mapResolution(resolution.outcome);
      let txHash: Hex | null = null;

      if (legAdapter === adminAddr) {
        // Admin path — one-shot resolve.
        const alreadyResolved = await publicClient.readContract({
          address: contracts.AdminOracleAdapter.address,
          abi: ADMIN_ORACLE_ABI,
          functionName: "canResolve",
          args: [legId],
        });
        if (!alreadyResolved) {
          txHash = await walletClient.writeContract({
            address: contracts.AdminOracleAdapter.address,
            abi: ADMIN_ORACLE_ABI,
            functionName: "resolve",
            args: [legId, status, outcome],
            chain: walletClient.chain,
            account: walletClient.account!,
          });
          await publicClient.waitForTransactionReceipt({ hash: txHash });
        }
        await recordResolution({
          conditionId,
          outcome: resolution.outcome,
          yesTxHash: txHash,
          noTxHash: null,
        });
        out.resolved++;
      } else if (umaAddr && legAdapter === umaAddr) {
        // UMA path — two-phase: assert → wait liveness → settle.
        const umaContract = contracts.UmaOracleAdapter!.address;
        const finalized = await publicClient.readContract({
          address: umaContract,
          abi: UMA_ORACLE_ABI,
          functionName: "canResolve",
          args: [legId],
        });
        if (finalized) {
          await recordResolution({
            conditionId,
            outcome: resolution.outcome,
            yesTxHash: null,
            noTxHash: null,
          });
          out.resolved++;
          continue;
        }

        const existingAssertion = (await publicClient.readContract({
          address: umaContract,
          abi: UMA_ORACLE_ABI,
          functionName: "assertionByLeg",
          args: [legId],
        })) as Hex;

        if (existingAssertion === "0x0000000000000000000000000000000000000000000000000000000000000000") {
          // No assertion yet — post one.
          const claim = encodeClaim({
            legId,
            conditionId: row.txtsourceref as `0x${string}`,
            outcome: resolution.outcome === "VOIDED" ? "VOID" : (resolution.outcome as ClaimOutcome),
            asOfTs: Math.floor(Date.now() / 1000),
          });
          txHash = await walletClient.writeContract({
            address: umaContract,
            abi: UMA_ORACLE_ABI,
            functionName: "assertOutcome",
            args: [legId, status, outcome, claim],
            chain: walletClient.chain,
            account: walletClient.account!,
          });
          await publicClient.waitForTransactionReceipt({ hash: txHash });
          // Don't recordResolution yet — leg isn't finalized until liveness + settle.
          out.skipped++; // "pending liveness" bucket
        } else {
          // Assertion exists — try to settle. Reverts pre-liveness; swallow + skip.
          try {
            txHash = await walletClient.writeContract({
              address: umaContract,
              abi: UMA_ORACLE_ABI,
              functionName: "settleMature",
              args: [legId],
              chain: walletClient.chain,
              account: walletClient.account!,
            });
            await publicClient.waitForTransactionReceipt({ hash: txHash });
            await recordResolution({
              conditionId,
              outcome: resolution.outcome,
              yesTxHash: txHash,
              noTxHash: null,
            });
            out.resolved++;
          } catch {
            out.skipped++; // likely pre-liveness revert
          }
        }
      } else {
        // Unknown oracle adapter — skip rather than misroute.
        out.skipped++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.errors.push(`resolve ${conditionId.slice(0, 10)}: ${msg.slice(0, 200)}`);
    }
  }

  return out;
}

interface PhaseBResult {
  settled: number;
  errors: string[];
}

async function settleTickets(
  publicClient: PublicClient,
  walletClient: WalletClient,
  contracts: ChainContracts,
): Promise<PhaseBResult> {
  const out: PhaseBResult = { settled: 0, errors: [] };

  let ticketCount: bigint;
  try {
    ticketCount = (await publicClient.readContract({
      address: contracts.ParlayEngine.address,
      abi: ENGINE_ABI,
      functionName: "ticketCount",
    })) as bigint;
  } catch (e) {
    out.errors.push(`ticketCount: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }

  const count = Number(ticketCount);
  for (let id = 0; id < count; id++) {
    try {
      const ticket = (await publicClient.readContract({
        address: contracts.ParlayEngine.address,
        abi: ENGINE_ABI,
        functionName: "getTicket",
        args: [BigInt(id)],
      })) as {
        status: number;
        legIds: readonly bigint[];
      };

      if (ticket.status !== TicketStatus.Active) continue;

      let allResolvable = true;
      for (const legId of ticket.legIds) {
        const leg = (await publicClient.readContract({
          address: contracts.LegRegistry.address,
          abi: REGISTRY_ABI,
          functionName: "getLeg",
          args: [legId],
        })) as { oracleAdapter: `0x${string}` };

        const canResolve = (await publicClient.readContract({
          address: getAddress(leg.oracleAdapter),
          abi: ORACLE_READ_ABI,
          functionName: "canResolve",
          args: [legId],
        })) as boolean;

        if (!canResolve) {
          allResolvable = false;
          break;
        }
      }

      if (!allResolvable) continue;

      const hash = await walletClient.writeContract({
        address: contracts.ParlayEngine.address,
        abi: ENGINE_ABI,
        functionName: "settleTicket",
        args: [BigInt(id)],
        chain: walletClient.chain,
        account: walletClient.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      out.settled++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.errors.push(`settle #${id}: ${msg.slice(0, 200)}`);
    }
  }

  return out;
}
