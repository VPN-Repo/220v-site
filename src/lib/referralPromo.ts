import { useEffect, useState } from "react";

import { apiGet } from "@/lib/api";

/** Rules and availability from `GET /api/me/referrals/config`. */
export type ReferralConfig = {
  pointsPerDay: number;
  registrationPoints: number;
  firstPaymentPoints: Record<string, number>;
  repeatPaymentPercent: number;
  /** False when accrual is blocked or the exchange is restricted for this user. */
  available: boolean;
  /** RMW "active paid tariff" flag; null when unknown. */
  eligible: boolean | null;
};

const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

export function parseReferralConfig(raw: unknown): ReferralConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const pointsPerDay = positive(data.pointsPerDay);
  if (!pointsPerDay) return null;

  const firstPaymentPoints: Record<string, number> = {};
  if (data.firstPaymentPoints && typeof data.firstPaymentPoints === "object") {
    for (const [tier, value] of Object.entries(data.firstPaymentPoints as Record<string, unknown>)) {
      const points = positive(value);
      if (points) firstPaymentPoints[tier] = points;
    }
  }

  return {
    pointsPerDay,
    registrationPoints: positive(data.registrationPoints) ?? 0,
    firstPaymentPoints,
    repeatPaymentPercent: positive(data.repeatPaymentPercent) ?? 0,
    available: data.available === true,
    eligible: typeof data.eligible === "boolean" ? data.eligible : null,
  };
}

/** Largest first-payment reward (the 12-month tier today), or null when unknown. */
export function maxFirstPaymentPoints(config: ReferralConfig | null): number | null {
  if (!config) return null;
  const values = Object.values(config.firstPaymentPoints);
  return values.length ? Math.max(...values) : null;
}

/** Points for one tier (`1m`, `6m`, `12m`), or null when the API did not send it. */
export function tierPoints(config: ReferralConfig | null, tier: string): number | null {
  return config?.firstPaymentPoints[tier] ?? null;
}

/** Repeat-payment reward for a tier, rounded down like a whole-point accrual. */
export function repeatTierPoints(config: ReferralConfig | null, tier: string): number | null {
  const first = tierPoints(config, tier);
  if (!first || !config?.repeatPaymentPercent) return null;
  return Math.floor((first * config.repeatPaymentPercent) / 100);
}

export function pluralPoints(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "балл";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "балла";
  return "баллов";
}

export function useReferralConfig(enabled = true): { config: ReferralConfig | null; loaded: boolean } {
  const [state, setState] = useState<{ config: ReferralConfig | null; loaded: boolean }>({
    config: null,
    loaded: false,
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await apiGet<unknown>("/me/referrals/config");
      if (cancelled) return;
      setState({ config: error ? null : parseReferralConfig(data), loaded: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}

// ---- Link and share targets ----

export function buildReferralLink(origin: string, userUuid: string | null | undefined): string {
  const uuid = typeof userUuid === "string" ? userUuid.trim() : "";
  if (!uuid || !origin) return "";
  return `${origin}/?ref=${encodeURIComponent(uuid)}`;
}

export const REFERRAL_SHARE_INTRO = "Подключился к 220 Вольт — соединение держит как надо ⚡";
const REFERRAL_SHARE_LEAD = `${REFERRAL_SHARE_INTRO} Заходи по моей ссылке:`;

/** Ready-to-send message with the link at the end. */
export function referralShareText(link: string): string {
  return `${REFERRAL_SHARE_LEAD} ${link}`;
}

export type ReferralShareTarget = {
  key: "telegram" | "whatsapp" | "vk";
  label: string;
  href: string;
};

export function referralShareTargets(link: string): ReferralShareTarget[] {
  const url = encodeURIComponent(link);
  return [
    {
      key: "telegram",
      label: "Telegram",
      // Telegram prints the url itself, so the text stops before it.
      href: `https://t.me/share/url?url=${url}&text=${encodeURIComponent(REFERRAL_SHARE_LEAD)}`,
    },
    {
      key: "whatsapp",
      label: "WhatsApp",
      href: `https://wa.me/?text=${encodeURIComponent(referralShareText(link))}`,
    },
    {
      key: "vk",
      label: "VK",
      href: `https://vk.com/share.php?url=${url}&title=${encodeURIComponent(REFERRAL_SHARE_INTRO)}`,
    },
  ];
}

export function canNativeShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/**
 * Opens the system share sheet. Resolves to "shared", "cancelled" (the user closed
 * the sheet) or "unsupported" so the caller can fall back to copying the text.
 */
export async function nativeShareReferral(link: string): Promise<"shared" | "cancelled" | "unsupported"> {
  if (!canNativeShare()) return "unsupported";
  try {
    await navigator.share({ title: "220 Вольт", text: REFERRAL_SHARE_LEAD, url: link });
    return "shared";
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    return "unsupported";
  }
}

// ---- Dashboard strip dismissal ----

export const REFERRAL_PROMO_DISMISS_KEY = "v220_referral_promo_dismissed_at";
export const REFERRAL_PROMO_DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function isReferralPromoDismissed(now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(REFERRAL_PROMO_DISMISS_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts) || now - ts > REFERRAL_PROMO_DISMISS_TTL_MS) {
      localStorage.removeItem(REFERRAL_PROMO_DISMISS_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function dismissReferralPromo(now = Date.now()): void {
  try {
    localStorage.setItem(REFERRAL_PROMO_DISMISS_KEY, String(now));
  } catch {
    // Private mode: the strip stays hidden until the next page load.
  }
}
