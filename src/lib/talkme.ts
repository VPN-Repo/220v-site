/**
 * Talk-Me: скрипт подключается с страницы поддержки (ensureTalkMeScript).
 * Очередь window.TalkMe до загрузки support.js.
 *
 * setClientInfo: https://talk-me.ru/kb/api/widget/client/setclientinfo.html
 * Открытие чата: TalkMe("openSupport").
 * Встроенный режим: div#onlineSupportContainer внутри страницы (кнопка скрыта).
 */

const SITE_NAME = import.meta.env.VITE_SITE_NAME?.trim() || "220v";
const TALKME_WIDGET_HASH = "d1845a025366171ec550f455fd14c266";

let talkMeCloseFollowUpId: number | null = null;

function clearTalkMeCloseFollowUp(): void {
  if (talkMeCloseFollowUpId !== null) {
    window.clearTimeout(talkMeCloseFollowUpId);
    talkMeCloseFollowUpId = null;
  }
}

/** Однократно вставляет support.js (как в стандартном коде Talk-Me). */
export function ensureTalkMeScript(options?: { clientId?: string }): void {
  const clientId = typeof options?.clientId === "string" ? options.clientId.trim() : "";

  const w = window as Window & { TalkMeSetup?: { language?: string; clientId?: string } };
  w.TalkMeSetup = {
    ...w.TalkMeSetup,
    language: "ru",
    ...(clientId ? { clientId } : {}),
  };

  if (document.getElementById("supportScript")) return;

  const d = document;
  const m = "TalkMe";
  const win = w as unknown as Record<string, unknown>;
  win.supportAPIMethod = m;
  win[m] =
    typeof win[m] === "function"
      ? win[m]
      : function (...args: unknown[]) {
          const fn = win[m] as { q?: unknown[] };
          (fn.q = fn.q || []).push(args);
        };

  const append = (useIntl: boolean) => {
    const s = d.createElement("script");
    s.id = "supportScript";
    s.async = true;
    s.src = `${useIntl ? "https://static.site-chat.me/support/support.int.js" : "https://lcab.talk-me.ru/support/support.js"}?h=${TALKME_WIDGET_HASH}`;
    s.onerror = useIntl
      ? undefined
      : () => {
          s.remove();
          append(true);
        };
    (d.head || d.body).appendChild(s);
  };

  append(false);
}

/** Поля custom для карточки оператора (системные имена полей в Talk-Me) */
export type TalkMeCustomFields = {
  Traffic?: string;
  Expiration_date?: string;
  Devices?: string;
  Tariff?: string;
};

export type OpenTalkMeChatOptions = {
  email?: string;
  custom?: TalkMeCustomFields;
};

/** Снимок профиля из ЛК для автозаполнения custom */
export type TalkMeProfileSnapshot = {
  usedTrafficBytes?: number;
  trafficLimitBytes?: number;
  expireAt?: string;
  currentDevices?: number;
  devicesLimit?: number;
  tariff?: string;
  plan?: string;
};

function bytesToGbRounded(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.max(0, Math.round(bytes / (1024 * 1024 * 1024)));
}

/**
 * Формирует custom для setClientInfo из данных пользователя ЛК.
 * Пример: Traffic "25Gb/100Gb", Devices "5/7", Tariff из RMW.
 */
export function buildTalkMeCustomFields(profile: TalkMeProfileSnapshot): TalkMeCustomFields {
  const usedGb = bytesToGbRounded(profile.usedTrafficBytes ?? 0);
  const limitBytes = profile.trafficLimitBytes ?? 0;
  const limitGb = bytesToGbRounded(limitBytes);
  const traffic =
    limitBytes > 0 ? `${usedGb}Gb/${limitGb}Gb` : `${usedGb}Gb/—`;

  let expiration_date = "";
  const raw = profile.expireAt?.trim();
  if (raw) {
    const d = new Date(raw);
    expiration_date = Number.isNaN(d.getTime())
      ? raw
      : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  const cur = Math.max(0, Math.floor(profile.currentDevices ?? 0));
  const max = Math.max(0, Math.floor(profile.devicesLimit ?? 0));
  const devices = max > 0 ? `${cur}/${max}` : `${cur}/—`;

  const tariffRaw = (profile.tariff?.trim() || profile.plan?.trim() || "").replace(/^—$/, "");
  const tariff = tariffRaw || "—";

  return {
    Traffic: traffic,
    Expiration_date: expiration_date || "—",
    Devices: devices,
    Tariff: tariff,
  };
}

function getTalkMeApi(): ((...args: unknown[]) => void) | null {
  const w = window as Window & { supportAPIMethod?: string };
  const methodName =
    typeof w.supportAPIMethod === "string" && w.supportAPIMethod.trim() ? w.supportAPIMethod : "TalkMe";
  const api = (w as unknown as Record<string, unknown>)[methodName];
  if (typeof api !== "function") {
    console.warn("[TalkMe] API не готово:", methodName);
    return null;
  }
  return api as (...args: unknown[]) => void;
}

function openSupport(api: (...args: unknown[]) => void) {
  try {
    api("openSupport");
  } catch (e) {
    console.warn("[TalkMe] openSupport не сработал:", e);
  }
}

function pickDefinedCustom(custom?: TalkMeCustomFields): Record<string, string> | undefined {
  if (!custom) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(custom)) {
    if (typeof v === "string" && v.length > 0) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildTalkMeVisitorName(): string {
  return SITE_NAME;
}

function buildTalkMeClientInfo(options?: OpenTalkMeChatOptions): Record<string, unknown> {
  const email = typeof options?.email === "string" ? options.email.trim() : "";
  const params: Record<string, unknown> = {
    name: buildTalkMeVisitorName(),
  };
  if (email) {
    params.email = email;
  }

  const customObj = pickDefinedCustom(options?.custom);
  if (customObj) {
    params.custom = customObj;
  }

  // Plain object: очередь Talk-Me до загрузки support.js иногда «ломает» вложенные структуры
  // или не вызывает callback; без JSON-копии custom мог не доходить до оператора.
  let paramsPlain: Record<string, unknown>;
  try {
    paramsPlain = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
  } catch {
    paramsPlain = { ...params };
    if (customObj) {
      paramsPlain.custom = { ...customObj };
    }
  }

  return paramsPlain;
}

export function setTalkMeClientInfo(options?: OpenTalkMeChatOptions): void {
  clearTalkMeCloseFollowUp();

  const api = getTalkMeApi();
  if (!api) return;

  const paramsPlain = buildTalkMeClientInfo(options);

  try {
    api("setClientInfo", paramsPlain);
  } catch (e) {
    console.warn("[TalkMe] setClientInfo не сработал:", e);
  }
}

export function openTalkMeChat(options?: OpenTalkMeChatOptions): void {
  const api = getTalkMeApi();
  if (!api) return;

  setTalkMeClientInfo(options);

  // Открываем чат после тика, чтобы виджет успел применить setClientInfo (как при ручном вызове в консоли по шагам).
  window.setTimeout(() => openSupport(api), 300);
}

/** Закрыть окно чата и скрыть плавающую кнопку (например, после закрытия модалки с #onlineSupportContainer). */
export function closeTalkMeWidget(): void {
  clearTalkMeCloseFollowUp();

  const api = getTalkMeApi();
  if (!api) return;
  try {
    api("closeSupport");
  } catch (e) {
    console.warn("[TalkMe] closeSupport не сработал:", e);
  }
  try {
    api("hideTrigger");
  } catch (e) {
    console.warn("[TalkMe] hideTrigger не сработал:", e);
  }
  // Повтор только для плавающей кнопки; отменяется при следующем openTalkMeChat
  talkMeCloseFollowUpId = window.setTimeout(() => {
    talkMeCloseFollowUpId = null;
    try {
      api("hideTrigger");
    } catch {
      /* ignore */
    }
  }, 250);
}
