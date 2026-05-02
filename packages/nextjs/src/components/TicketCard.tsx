"use client";

import { formatUSDC } from "@/lib/utils";
import { useSettleTicket, useClaimPayout, useCashoutEarly } from "@/lib/hooks";

export type TicketStatus = "Active" | "Won" | "Lost" | "Voided" | "Claimed";

export interface TicketLeg {
  description: string;
  odds: number;
  outcomeChoice: number; // 1 = yes, 2 = no, 0 = unknown
  resolved: boolean;
  result: number; // 0 = unresolved, 1 = Won, 2 = Lost, 3 = Voided (oracle LegStatus)
  probabilityPPM?: number;
  /** On-chain legId, surfaced on hover for provenance. */
  legId?: bigint;
}

export interface TicketData {
  id: bigint;
  stake: bigint;
  feePaid: bigint;
  payout: bigint;
  legs: TicketLeg[];
  status: TicketStatus;
  createdAt: number;
  cashoutValue?: bigint;
}

const STATUS_STYLES: Record<TicketStatus, string> = {
  Active: "bg-brand-pink/15 text-brand-pink border-brand-pink/30",
  Won: "bg-brand-green/20 text-brand-green border-brand-green/30",
  Lost: "bg-neon-red/20 text-neon-red border-neon-red/30",
  Voided: "bg-brand-amber/20 text-brand-amber border-brand-amber/30",
  Claimed: "bg-brand-purple/15 text-brand-purple-1 border-brand-purple/30",
};

const LEG_STATUS_CONFIG: Record<
  "win" | "loss" | "voided" | "pending",
  { label: string; tooltip: string; style: string }
> = {
  win: { label: "W", tooltip: "Won", style: "bg-brand-green/20 text-brand-green" },
  loss: { label: "L", tooltip: "Lost", style: "bg-neon-red/20 text-neon-red" },
  voided: { label: "X", tooltip: "Voided", style: "bg-brand-amber/20 text-brand-amber" },
  pending: { label: "P", tooltip: "Pending", style: "bg-white/10 text-gray-400" },
};

function getLegStatus(leg: TicketLeg): "win" | "loss" | "voided" | "pending" {
  if (!leg.resolved) return "pending";
  if (leg.outcomeChoice !== 1 && leg.outcomeChoice !== 2) return "pending";
  if (leg.result === 3) return "voided";
  const isNoBet = leg.outcomeChoice === 2;
  if (leg.result === 1) return isNoBet ? "loss" : "win";
  if (leg.result === 2) return isNoBet ? "win" : "loss";
  return "pending";
}

export function TicketCard({ ticket }: { ticket: TicketData }) {
  const { settle, isPending: isSettling } = useSettleTicket();
  const { claim, isPending: isClaiming } = useClaimPayout();
  const { cashoutEarly, isPending: isCashingOut } = useCashoutEarly();

  const multiplier = ticket.legs.reduce((acc, l) => acc * l.odds, 1);
  const allResolved = ticket.legs.every((l) => l.resolved);
  const hasLostLeg = ticket.legs.some((l) => getLegStatus(l) === "loss");
  const canSettle = ticket.status === "Active" && allResolved;
  const canClaim = ticket.status === "Won";
  // Cashout is available on any Active ticket with no lost leg; value is
  // assessed at cashout time from resolved/unresolved legs.
  const canCashout = ticket.status === "Active" && !hasLostLeg && !allResolved;

  return (
    <div className="glass-card flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
        <div>
          <span className="text-xs text-gray-500">Ticket</span>
          <h3 className="text-lg font-bold text-white">
            #{ticket.id.toString()}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_STYLES[ticket.status]}`}
          >
            {ticket.status}
          </span>
        </div>
      </div>

      {/* Legs */}
      <div className="flex-1 divide-y divide-white/5 px-6">
        {ticket.legs.map((leg, i) => {
          const status = getLegStatus(leg);
          return (
            <div key={i} className="flex items-center gap-3 py-3">
              <div className="group relative flex-shrink-0">
                <div
                  className={`flex h-7 w-7 cursor-help items-center justify-center rounded-full text-xs font-bold ${LEG_STATUS_CONFIG[status].style}`}
                  tabIndex={0}
                  aria-label={LEG_STATUS_CONFIG[status].tooltip}
                  title={LEG_STATUS_CONFIG[status].tooltip}
                >
                  {LEG_STATUS_CONFIG[status].label}
                </div>
                <div
                  className="pointer-events-none absolute left-full top-1/2 z-10 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  aria-hidden="true"
                >
                  {LEG_STATUS_CONFIG[status].tooltip}
                  <div className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-gray-800" />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-sm text-gray-300"
                  title={leg.legId !== undefined ? `Leg #${leg.legId.toString()}` : undefined}
                >
                  {leg.description}
                </p>
                <p className="text-xs text-gray-500">
                  {leg.odds.toFixed(1)}x &middot;{" "}
                  <span className={leg.outcomeChoice === 1 ? "text-brand-green" : leg.outcomeChoice === 2 ? "text-brand-amber" : ""}>
                    {leg.outcomeChoice === 1 ? "YES" : leg.outcomeChoice === 2 ? "NO" : "?"}
                  </span>
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="border-t border-white/5 px-6 py-4">
        <div className="mb-4 grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-xs text-gray-500">Stake</p>
            <p className="font-semibold text-white">
              ${formatUSDC(ticket.stake)}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Multiplier</p>
            <p className="gradient-text-gold text-glow-gold font-bold">
              {multiplier.toFixed(2)}x
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Payout</p>
            <p className="font-bold text-brand-green">
              ${formatUSDC(ticket.payout)}
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          {canSettle && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); settle(ticket.id); }}
              disabled={isSettling}
              className="flex-1 rounded-xl border border-brand-pink/30 bg-brand-pink/10 py-2.5 text-sm font-semibold text-brand-pink transition-all hover:bg-brand-pink/20 disabled:opacity-50"
            >
              {isSettling ? "Settling..." : "Settle"}
            </button>
          )}
          {canClaim && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); claim(ticket.id); }}
              disabled={isClaiming}
              className="flex-1 rounded-xl bg-gradient-to-r from-brand-green/80 to-brand-green py-2.5 text-sm font-bold text-black transition-all hover:shadow-lg hover:shadow-brand-green/20 disabled:opacity-50"
            >
              {isClaiming ? "Claiming..." : "Claim Payout"}
            </button>
          )}
          {canCashout && (
            <button
              onClick={(e) => {
                e.preventDefault(); e.stopPropagation();
                const minOut = ticket.cashoutValue ? (ticket.cashoutValue * 98n) / 100n : 0n;
                cashoutEarly(ticket.id, minOut);
              }}
              disabled={isCashingOut}
              className="flex-1 rounded-xl border border-brand-amber/30 bg-brand-amber/10 py-2.5 text-sm font-semibold text-brand-amber transition-all hover:bg-brand-amber/20 disabled:opacity-50"
            >
              {isCashingOut ? "Cashing out..." : ticket.cashoutValue
                ? `Cash Out ~$${formatUSDC(ticket.cashoutValue)}`
                : "Cash Out Early"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
