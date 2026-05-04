export enum SettlementMode {
  FAST = "FAST",
  OPTIMISTIC = "OPTIMISTIC",
}

export enum PayoutMode {
  CLASSIC = "CLASSIC",
  PROGRESSIVE = "PROGRESSIVE",
  EARLY_CASHOUT = "EARLY_CASHOUT",
}

export enum TicketStatus {
  Active = "Active",
  Won = "Won",
  Lost = "Lost",
  Voided = "Voided",
  Claimed = "Claimed",
}

export enum LegStatus {
  Unresolved = "Unresolved",
  Won = "Won",
  Lost = "Lost",
  Voided = "Voided",
}

export interface Leg {
  /** On-chain leg id for the "yes" side. For polymarket markets this is the
   *  yes-token leg; for seed markets (single-sided) this is the only leg. */
  id: number;
  /** On-chain leg id for the "no" side. Only present for polymarket markets;
   *  seed markets omit this so the frontend hides the No button. */
  noId?: number;
  question: string;
  sourceRef: string;
  cutoffTime: number;
  earliestResolve: number;
  /** Yes-side probability in PPM. */
  probabilityPPM: number;
  /** No-side probability in PPM (polymarket only). */
  noProbabilityPPM?: number;
  active: boolean;
  /** Correlation group ID. Legs sharing this id (typically same game) get a
   *  saturating multiplier discount. 0 = uncorrelated. */
  correlationGroupId?: number;
  /** Mutual-exclusion group ID. At most one leg from a group can be in the
   *  cart — the builder greys out conflicting legs and the engine reverts
   *  on duplicate non-zero ids. 0 = no exclusion. */
  exclusionGroupId?: number;
}

export interface Market {
  id: string;
  title: string;
  description: string;
  legs: Leg[];
  category: string;
  imageUrl?: string;
  gameGroup?: string;
}

export interface Ticket {
  id: number;
  owner: string;
  stake: bigint;
  legIds: number[];
  outcomes: string[];
  multiplierX1e6: bigint;
  potentialPayout: bigint;
  feePaid: bigint;
  mode: SettlementMode;
  payoutMode: PayoutMode;
  claimedAmount: bigint;
  status: TicketStatus;
  createdAt: number;
}

export interface QuoteRequest {
  legIds: number[];
  outcomes: string[];
  stake: string; // USDC amount as string (6 decimals)
}

export interface QuoteResponse {
  legIds: number[];
  outcomes: string[];
  stake: string;
  multiplierX1e6: string;
  potentialPayout: string;
  probabilities: number[];
  valid: boolean;
  reason?: string;
}

export interface VaultStats {
  totalAssets: string;
  totalReserved: string;
  freeLiquidity: string;
  utilizationBps: number;
  totalShares: string;
}

export interface ExposureReport {
  totalExposure: string;
  ticketCount: number;
  byLeg: Record<number, string>;
  hedgeActions: HedgeAction[];
}

export interface HedgeAction {
  ticketId: number;
  legId: number;
  amount: string;
  action: "hedge" | "unwind";
  status: "simulated" | "executed";
  timestamp: number;
}

export type RiskProfile = "conservative" | "moderate" | "aggressive";

export enum RiskAction {
  BUY = "BUY",
  REDUCE_STAKE = "REDUCE_STAKE",
  AVOID = "AVOID",
}

export enum VaultHealth {
  HEALTHY = "HEALTHY",
  CAUTION = "CAUTION",
  CRITICAL = "CRITICAL",
}

export enum ConcentrationWarning {
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  LOW = "LOW",
}

export enum YieldAction {
  ROTATE = "ROTATE",
  HOLD = "HOLD",
}

export interface RiskAssessRequest {
  legIds: number[];
  outcomes: string[];
  stake: string;
  probabilities: number[];
  bankroll: string;
  riskTolerance: RiskProfile;
  categories?: string[];
}

export interface RiskAssessResponse {
  action: RiskAction;
  suggestedStake: string;
  kellyFraction: number;
  winProbability: number;
  expectedValue: number;
  confidence: number;
  reasoning: string;
  warnings: string[];
  riskTolerance: RiskProfile;
  fairMultiplier: number;
  netMultiplier: number;
}

export interface AgentQuoteRequest {
  legIds: number[];
  outcomes: string[];
  stake: string;
  bankroll: string;
  riskTolerance: RiskProfile;
}

export interface AiInsight {
  analysis: string;
  model: string;
  provider: string;
  verified: boolean;
}

export interface AgentQuoteResponse {
  quote: QuoteResponse;
  risk: RiskAssessResponse;
  aiInsight?: AiInsight;
}
