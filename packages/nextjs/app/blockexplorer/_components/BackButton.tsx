"use client";

import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

export const BackButton = () => {
  const router = useRouter();
  return (
    <button
      onClick={() => router.back()}
      className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-300 transition-colors hover:border-brand-pink/40 hover:bg-brand-pink/10 hover:text-brand-pink"
    >
      <ChevronLeft className="h-3 w-3" />
      Back
    </button>
  );
};
