// Legacy codes (1month…) and the current RMW tariff keys (basic_1m…) are all paid subscriptions.
export const PAID_TARIFF_CODES = new Set([
  "1month",
  "6month",
  "12month",
  "basic_1m",
  "basic_6m",
  "pro_6m",
  "premium_12m",
]);
// Plan labels as rendered by the API (displayPlanFromTariff), lower-cased.
export const PAID_PLAN_LABELS = new Set([
  "1 месяц",
  "6 месяцев",
  "12 месяцев",
  "базовый — 1 месяц",
  "базовый — 6 месяцев",
  "pro — 6 месяцев",
  "premium — 12 месяцев",
]);

/** True when the tariff/plan names a paid subscription, regardless of expiry. */
export function isPaidTariff(tariff: unknown, plan: unknown): boolean {
  const t = typeof tariff === "string" ? tariff.trim().toLowerCase() : "";
  const p = typeof plan === "string" ? plan.trim().toLowerCase() : "";
  return PAID_TARIFF_CODES.has(t) || p === "premium" || PAID_PLAN_LABELS.has(p);
}

export function resolveIsPremium(user: unknown): boolean {
  if (!user || typeof user !== "object") return false;
  const raw = user as Record<string, unknown>;
  const tariff = typeof raw.tariff === "string" ? raw.tariff.toLowerCase() : "";
  const plan = typeof raw.plan === "string" ? raw.plan.toLowerCase() : "";
  const expireAt = typeof raw.expireAt === "string" ? raw.expireAt : "";
  
  const hasPaidTariff = isPaidTariff(tariff, plan);

  if (!hasPaidTariff) return false;

  if (expireAt) {
    const expDate = new Date(expireAt);
    if (!Number.isNaN(expDate.getTime())) {
      return expDate.getTime() > Date.now();
    }
  }

  return true;
}
