/**
 * Chatwoot (self-hosted) website widget.
 *
 * The SDK is loaded at runtime from `${VITE_CHATWOOT_BASE_URL}/packs/js/sdk.js` (no npm dependency).
 * `window.$chatwoot` becomes usable only after the `chatwoot:ready` event, so every call made
 * before that is queued and flushed on ready.
 *
 * SDK reference: https://www.chatwoot.com/hc/user-guide/articles/1677587234-how-to-send-additional-user-information-to-chatwoot-using-sdk
 */

const SCRIPT_ID = "chatwootScript";

type ChatwootUserInfo = {
  email?: string;
  name?: string;
  identifier_hash?: string;
};

export type ChatwootApi = {
  toggle: (state?: "open" | "close") => void;
  setUser: (identifier: string, user: ChatwootUserInfo) => void;
  setCustomAttributes: (attributes: Record<string, string | number | boolean>) => void;
  setLocale?: (locale: string) => void;
  reset: () => void;
};

type ChatwootWindow = Window & {
  chatwootSettings?: Record<string, unknown>;
  chatwootSDK?: { run: (config: { websiteToken: string; baseUrl: string }) => void };
  $chatwoot?: ChatwootApi;
};

type ChatwootConfig = { baseUrl: string; websiteToken: string };

let ready = false;
let loadFailed = false;
let queue: Array<(api: ChatwootApi) => void> = [];
let readyListenerAttached = false;

function cwWindow(): ChatwootWindow {
  return window as ChatwootWindow;
}

function readConfig(): ChatwootConfig | null {
  const baseUrl = (import.meta.env.VITE_CHATWOOT_BASE_URL as string | undefined)?.trim().replace(/\/+$/, "") ?? "";
  const websiteToken = (import.meta.env.VITE_CHATWOOT_WEBSITE_TOKEN as string | undefined)?.trim() ?? "";
  if (!baseUrl || !websiteToken) return null;
  return { baseUrl, websiteToken };
}

/** Chatwoot is used only when both build-time variables are set. */
export function isChatwootEnabled(): boolean {
  return readConfig() !== null;
}

/** True once the SDK script failed to load (e.g. blocked); callers can fall back to /support. */
export function hasChatwootFailed(): boolean {
  return loadFailed;
}

function flushQueue(): void {
  const api = cwWindow().$chatwoot;
  if (!api) return;
  const pending = queue;
  queue = [];
  for (const fn of pending) {
    try {
      fn(api);
    } catch (e) {
      console.warn("[Chatwoot] call failed:", e);
    }
  }
}

function onReady(): void {
  ready = true;
  flushQueue();
}

/** Inserts the SDK once and runs it. No-op when Chatwoot is not configured. */
export function ensureChatwootScript(): void {
  const config = readConfig();
  if (!config) return;

  if (!readyListenerAttached) {
    window.addEventListener("chatwoot:ready", onReady);
    readyListenerAttached = true;
  }
  if (document.getElementById(SCRIPT_ID)) return;

  const w = cwWindow();
  w.chatwootSettings = {
    ...w.chatwootSettings,
    hideMessageBubble: true,
    position: "right",
    locale: "ru",
    type: "standard",
  };

  loadFailed = false;
  const s = document.createElement("script");
  s.id = SCRIPT_ID;
  s.async = true;
  s.defer = true;
  s.src = `${config.baseUrl}/packs/js/sdk.js`;
  s.onload = () => {
    try {
      cwWindow().chatwootSDK?.run({ websiteToken: config.websiteToken, baseUrl: config.baseUrl });
    } catch (e) {
      console.warn("[Chatwoot] SDK run failed:", e);
    }
  };
  s.onerror = () => {
    loadFailed = true;
    queue = [];
    s.remove();
    console.warn("[Chatwoot] SDK failed to load");
  };
  (document.head || document.body).appendChild(s);
}

/** Runs `fn` now if the widget is ready, otherwise after `chatwoot:ready`. */
function withChatwoot(fn: (api: ChatwootApi) => void): void {
  if (!isChatwootEnabled()) return;
  const api = cwWindow().$chatwoot;
  if (ready && api) {
    try {
      fn(api);
    } catch (e) {
      console.warn("[Chatwoot] call failed:", e);
    }
    return;
  }
  queue.push(fn);
  ensureChatwootScript();
}

export type ChatwootUser = {
  identifier: string;
  email?: string;
  name?: string;
  /** HMAC-SHA256 from GET /api/chat/identity; omitted when the server has no HMAC token. */
  identifierHash?: string | null;
};

export function setChatwootUser(user: ChatwootUser): void {
  const identifier = user.identifier.trim();
  if (!identifier) return;
  const info: ChatwootUserInfo = {};
  if (user.email) info.email = user.email;
  if (user.name) info.name = user.name;
  if (user.identifierHash) info.identifier_hash = user.identifierHash;
  withChatwoot((api) => api.setUser(identifier, info));
}

export function setChatwootCustomAttributes(attributes: Record<string, string | number | boolean>): void {
  withChatwoot((api) => api.setCustomAttributes(attributes));
}

/** Opens the widget (after load if needed). Returns false when Chatwoot is off or failed to load. */
export function openChatwoot(): boolean {
  if (!isChatwootEnabled() || loadFailed) return false;
  withChatwoot((api) => api.toggle("open"));
  return !loadFailed;
}

export function closeChatwoot(): void {
  if (!ready) return;
  withChatwoot((api) => api.toggle("close"));
}

function expireChatwootCookies(): void {
  // The SDK keeps the conversation in cw_conversation / cw_user_<token> cookies.
  try {
    for (const part of document.cookie.split(";")) {
      const name = part.split("=")[0]?.trim();
      if (name && (name === "cw_conversation" || name.startsWith("cw_user_"))) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      }
    }
  } catch {
    /* ignore */
  }
}

/** Logout: forget the contact and conversation so the next user starts clean. */
export function resetChatwoot(): void {
  queue = [];
  const api = cwWindow().$chatwoot;
  if (api) {
    try {
      api.reset();
    } catch (e) {
      console.warn("[Chatwoot] reset failed:", e);
    }
  }
  expireChatwootCookies();
}

/** Test-only: reset module state between tests. */
export function __resetChatwootStateForTests(): void {
  ready = false;
  loadFailed = false;
  queue = [];
  if (readyListenerAttached) {
    window.removeEventListener("chatwoot:ready", onReady);
    readyListenerAttached = false;
  }
  document.getElementById(SCRIPT_ID)?.remove();
}
