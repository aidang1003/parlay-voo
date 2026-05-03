"use client";

import {Check} from "lucide-react";
import {type ReactNode} from "react";

interface OnboardStepProps {
  index: number;
  title: string;
  description: ReactNode;
  complete: boolean;
  /** True when this is the first incomplete step — used to emphasize the action button. */
  active: boolean;
  /** Right-side slot. The step's primary action (button, link, status pill). */
  action: ReactNode;
}

export function OnboardStep({index, title, description, complete, active, action}: OnboardStepProps) {
  return (
    <div
      className={`glass-card flex items-center gap-4 rounded-2xl border p-5 transition-colors sm:gap-6 sm:p-6 ${
        complete
          ? "border-emerald-500/30 bg-emerald-500/[0.03]"
          : active
            ? "border-brand-pink/30"
            : "border-white/5"
      }`}
    >
      <Circle index={index} complete={complete} />

      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-bold text-white sm:text-base">{title}</h3>
        <div className="mt-0.5 text-xs text-gray-400 sm:text-sm">{description}</div>
      </div>

      <div className="flex-shrink-0">{action}</div>
    </div>
  );
}

function Circle({index, complete}: {index: number; complete: boolean}) {
  if (complete) {
    return (
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/20 ring-1 ring-emerald-500/40">
        <Check className="h-5 w-5 text-emerald-400" />
      </div>
    );
  }
  return (
    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-white/15 text-sm font-semibold text-gray-400">
      {index}
    </div>
  );
}

export function DonePill() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-500/30">
      <Check className="h-3 w-3" /> Done
    </span>
  );
}
