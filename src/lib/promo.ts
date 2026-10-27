/**
 * Промоссылки ?pdays=CODE (бонусные дни) и ?psale=CODE (скидка на следующую оплату).
 * Сам код живёт на сервере (HttpOnly-cookie до входа, затем серверная сессия), здесь —
 * только разбор ссылки, очистка адреса и проверки для экранов оплаты. См. docs/promocodes.md.
 */
import type { BillingPaymentMethod } from "./paymentMethods";

export type PromoCandidate = { kind: "days" | "sale"; code: string };
export type ActivePromo = { kind: "sale"; code: string; activated_at: string };
export type PromoLink =
  | { status: "none" }
  | { status: "invalid"; error: string }
  | { status: "valid"; candidate: PromoCandidate };

export const PROMO_LINK_PARAMS = ["pdays", "psale"] as const;
/** Событие окна после начисления дней: открытые экраны перечитывают профиль. */
export const PROMO_DAYS_APPLIED_EVENT = "v220:promo-days-applied";

export function hasPromoLinkParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return PROMO_LINK_PARAMS.some((key) => params.has(key));
}

export function parsePromoLink(search: string): PromoLink {
  const entries = [...new URLSearchParams(search)].filter(([key]) => key === "pdays" || key === "psale");
  if (!entries.length) return { status: "none" };
  if (entries.length !== 1) return { status: "invalid", error: "В ссылке больше одного промокода" };
  const [key, raw] = entries[0];
  const code = raw.trim().toUpperCase();
  if (!code || code.length > 64) return { status: "invalid", error: "Промокод в ссылке указан неверно" };
  return { status: "valid", candidate: { kind: key === "pdays" ? "days" : "sale", code } };
}

/** Убирает из адреса только параметры промокода, остальной query и hash не трогает. */
export function cleanPromoUrl({ pathname, search, hash }: { pathname: string; search: string; hash: string }) {
  const params = new URLSearchParams(search);
  for (const key of PROMO_LINK_PARAMS) params.delete(key);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

/** Ручной ввод кода скидки: всегда sale, без ссылок и параметров. */
export function parseManualPromo(
  input: string,
): { candidate: PromoCandidate; error?: never } | { candidate?: never; error: string } {
  const code = input.trim();
  if (!code) return { error: "Нужно ввести код скидки" };
  if (code.length > 64 || code.includes("://") || code.includes("=") || code.startsWith("?")) {
    return { error: "Нужен только код, без ссылки и параметров" };
  }
  return { candidate: { kind: "sale", code: code.toUpperCase() } };
}

/** Tribute не принимает промокоды: с сохранённой скидкой этот способ выключен. */
export function isPromoUnsupportedMethod(method: BillingPaymentMethod, promo: ActivePromo | null): boolean {
  return Boolean(promo) && method.provider?.trim().toLowerCase() === "tribute";
}

/**
 * Поле для /api/checkout: сервер сверит его с сессией и не создаст платёж по полной цене,
 * если показанная скидка там уже не сохранена.
 */
export function promoCheckoutFields(promo: ActivePromo | null): { expected_promo_code?: string } {
  return promo ? { expected_promo_code: promo.code } : {};
}

/** Русская плюральная форма для «день/дня/дней». */
export function pluralDays(n: number): string {
  const abs = Math.abs(Math.round(n)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return "дней";
  if (last === 1) return "день";
  if (last >= 2 && last <= 4) return "дня";
  return "дней";
}
