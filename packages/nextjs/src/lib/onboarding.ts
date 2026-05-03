"use client";

export const COMPLETED_KEY = "onboarding:completed";
export const COMPLETED_COOKIE = "onboarding_completed";

const FTUE_KEYS = ["ftue:completed"];

export function getCompleted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COMPLETED_KEY) === "true";
  } catch {
    return false;
  }
}

export function setCompleted(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COMPLETED_KEY, "true");
  } catch {
    // localStorage unavailable
  }
  document.cookie = `${COMPLETED_COOKIE}=true; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}

export function resetOnboarding(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(COMPLETED_KEY);
    for (const key of FTUE_KEYS) window.sessionStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
  document.cookie = `${COMPLETED_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}
