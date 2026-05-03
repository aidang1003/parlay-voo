"use client";

import {useRouter} from "next/navigation";
import {ArrowRight} from "lucide-react";
import {setCompleted} from "@/lib/onboarding";

export function EnterAppCTA({label = "Enter the app"}: {label?: string}) {
  const router = useRouter();

  const onClick = () => {
    setCompleted();
    router.push("/parlay");
  };

  return (
    <div className="glass-card rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-brand-pink/5 to-brand-purple/10 p-6 text-center sm:p-8">
      <p className="text-sm text-emerald-300">You&apos;re all set.</p>
      <h2 className="mt-1 text-2xl font-black text-white sm:text-3xl">
        Ready to <span className="gradient-text">build</span>.
      </h2>
      <button
        onClick={onClick}
        className="btn-gradient mt-5 inline-flex items-center gap-2 rounded-xl px-7 py-3 text-sm font-bold text-white sm:text-base"
      >
        {label}
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
