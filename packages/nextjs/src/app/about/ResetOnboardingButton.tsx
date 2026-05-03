"use client";

import {useRouter} from "next/navigation";
import {useState} from "react";
import {RotateCcw} from "lucide-react";
import {resetOnboarding} from "@/lib/onboarding";

export function ResetOnboardingButton() {
  const router = useRouter();
  const [done, setDone] = useState(false);

  const onClick = () => {
    resetOnboarding();
    setDone(true);
    router.push("/");
  };

  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 text-xs text-gray-500 transition-colors hover:text-gray-300"
      aria-label="Reset onboarding state"
    >
      <RotateCcw className="h-3 w-3" />
      {done ? "Reset — redirecting…" : "Reset onboarding"}
    </button>
  );
}
