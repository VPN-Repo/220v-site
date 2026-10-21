/** Поддерживаемые платформы в инструкциях по подключению. */
export type InstructionsPlatform =
  | "android"
  | "ios"
  | "windows"
  | "linux"
  | "appletv"
  | "androidtv";

export const INSTRUCTIONS_PLATFORMS: InstructionsPlatform[] = [
  "android",
  "ios",
  "windows",
  "linux",
  "appletv",
  "androidtv",
];

export function isInstructionsPlatform(value: unknown): value is InstructionsPlatform {
  return typeof value === "string" && (INSTRUCTIONS_PLATFORMS as string[]).includes(value);
}

/** Deep link для приложения Happ: добавление подписки в один клик. */
export function oneClickHappUrl(subscriptionUrl: string): string {
  return `happ://add/${encodeURIComponent(subscriptionUrl)}`;
}

/** Основной домен подписки 220v (SUB_PUBLIC_DOMAIN панели). */
export const HAPP_MAIN_HOST = "220v.click";
/** Резервный домен подписки: Happ переключается на него, если основной недоступен. */
export const HAPP_FALLBACK_HOST = "220vsub.online";
/** Название подписки в Happ. ASCII, чтобы не зависеть от разбора процент-кодировки в Happ. */
export const HAPP_TITLE = "220v";
/** Название резервной подписки в Happ. */
export const HAPP_FALLBACK_TITLE = "220v";

/**
 * Ссылка подписки для Happ с мета-параметрами во фрагменте:
 * `<url>#<title>?fallback-url=<encodeURIComponent(fallbackUrl#fallbackTitle)>`.
 * Резервная ссылка — тот же путь и query, только хост `220vsub.online`.
 * Ссылки не на 220v.click и неразбираемые строки возвращаются без изменений.
 */
export function happSubscriptionLink(subscriptionUrl: string): string {
  const raw = (subscriptionUrl ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return subscriptionUrl;
  }
  if (parsed.protocol !== "https:" || parsed.host.toLowerCase() !== HAPP_MAIN_HOST) {
    return subscriptionUrl;
  }
  const hashAt = raw.indexOf("#");
  const base = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const fallbackUrl = `https://${HAPP_FALLBACK_HOST}${parsed.pathname}${parsed.search}`;
  const fallbackWithTitle = `${fallbackUrl}#${encodeURIComponent(HAPP_FALLBACK_TITLE)}`;
  return `${base}#${encodeURIComponent(HAPP_TITLE)}?fallback-url=${encodeURIComponent(fallbackWithTitle)}`;
}

/** Deep link Happ для добавления подписки с резервным доменом. */
export function oneClickHappSubscriptionUrl(subscriptionUrl: string): string {
  return oneClickHappUrl(happSubscriptionLink(subscriptionUrl));
}
