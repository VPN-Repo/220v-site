// Тексты и пороги, которые помогают отличить докупку LTE-трафика от продления подписки.
import { isPaidTariff } from "@/lib/tariff";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Подписка, которой осталось не больше этого, считается «заканчивающейся»: при докупке LTE-трафика
 * предлагаем продлить подписку, а при исчерпанном трафике с большим запасом дней — докупить трафик.
 */
export const RENEWAL_HINT_THRESHOLD_MS = 3 * DAY_MS;

/** «1 день», «2 дня», «5 дней», «21 день». */
export function formatDaysRu(days: number): string {
  const n = Math.abs(Math.trunc(days));
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "день"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "дня"
        : "дней";
  return `${n} ${word}`;
}

function readString(user: unknown, key: string): string {
  if (!user || typeof user !== "object") return "";
  const value = (user as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function readNumber(user: unknown, key: string): number {
  if (!user || typeof user !== "object") return 0;
  const value = Number((user as Record<string, unknown>)[key]);
  return Number.isFinite(value) ? value : 0;
}

/** Миллисекунды до точного `expireAt` (NaN, если дата неизвестна). */
export function subscriptionMsLeft(user: unknown, now = Date.now()): number {
  const expireAtMs = Date.parse(readString(user, "expireAt"));
  return Number.isFinite(expireAtMs) ? expireAtMs - now : Number.NaN;
}

/** Дата окончания подписки «дд.мм.гггг» или «—». */
export function subscriptionEndLabel(user: unknown): string {
  const expireAtMs = Date.parse(readString(user, "expireAt"));
  if (!Number.isFinite(expireAtMs)) return "—";
  return new Date(expireAtMs).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function subscriptionEndsInText(msLeft: number): string {
  return msLeft < DAY_MS ? "менее чем через сутки" : `через ${formatDaysRu(Math.floor(msLeft / DAY_MS))}`;
}

/** Лимит LTE-трафика задан и уже израсходован. */
export function isLteTrafficExhausted(user: unknown): boolean {
  const limit = readNumber(user, "trafficLimitBytes");
  return limit > 0 && readNumber(user, "usedTrafficBytes") >= limit;
}

/** Трафик ещё можно купить, но подписка вот-вот закончится — вероятно, человек хотел продлить подписку. */
export function shouldWarnRenewInstead(msLeft: number, trafficRestriction: string | null): boolean {
  return !trafficRestriction && Number.isFinite(msLeft) && msLeft <= RENEWAL_HINT_THRESHOLD_MS;
}

/** Закончился только LTE-трафик, а дней подписки ещё много — продлевать не нужно. */
export function shouldHintTrafficInstead(user: unknown, msLeft: number, trafficRestriction: string | null): boolean {
  return (
    isLteTrafficExhausted(user) &&
    !trafficRestriction &&
    Number.isFinite(msLeft) &&
    msLeft > RENEWAL_HINT_THRESHOLD_MS
  );
}

export function lteTrafficExplainer(endLabel: string): string {
  return `Трафик считается только на LTE-серверах — на остальных безлимит. Купленные ГБ действуют до конца подписки (${endLabel}). Срок подписки не продлевается.`;
}

export function renewInsteadWarningText(msLeft: number, endLabel: string): string {
  return `Подписка заканчивается ${subscriptionEndsInText(msLeft)} (${endLabel}) — купленный LTE-трафик сгорит вместе с ней. Возможно, вы хотели продлить подписку?`;
}

export function trafficInsteadHintText(msLeft: number): string {
  return `У вас ещё ${formatDaysRu(Math.floor(msLeft / DAY_MS))} подписки — закончился только LTE-трафик. Его можно докупить отдельно, это дешевле.`;
}

/** Платная подписка ещё действует — покупка тарифа её продлит. */
export function isActivePaidSubscription(user: unknown, msLeft: number): boolean {
  if (!user || typeof user !== "object") return false;
  const raw = user as Record<string, unknown>;
  return isPaidTariff(raw.tariff, raw.plan) && Number.isFinite(msLeft) && msLeft > 0;
}
