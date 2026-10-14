/**
 * Support-chat facade. Components call these functions and do not care which provider is active:
 * - Chatwoot website widget when VITE_CHATWOOT_BASE_URL and VITE_CHATWOOT_WEBSITE_TOKEN are both set at build time;
 * - Talk-Me otherwise (exactly the previous behaviour: the custom chat on /chat).
 */
import { apiGet } from "@/lib/api";
import {
  ensureChatwootScript,
  isChatwootEnabled,
  openChatwoot,
  resetChatwoot,
  setChatwootCustomAttributes,
  setChatwootUser,
} from "@/lib/chatwoot";
import { buildTalkMeCustomFields, openTalkMeChat, type TalkMeProfileSnapshot } from "@/lib/talkme";
import { getVpnTalkmeProfileRaw } from "@/lib/vpnStorage";

export type SupportChatProvider = "chatwoot" | "talkme";

/** Value of the `site` custom attribute: identifies this brand in the shared Chatwoot account. */
export const CHATWOOT_SITE = "220v";

export function getSupportChatProvider(): SupportChatProvider {
  return isChatwootEnabled() ? "chatwoot" : "talkme";
}

export type SupportChatOptions = {
  /** Logged-in user's email; without it the chat is anonymous. */
  email?: string | null;
};

type ChatIdentityResponse = {
  identifier?: string;
  identifier_hash?: string | null;
  email?: string;
  name?: string;
};

/** Identity is fetched once per logged-in email; cleared on logout. */
let identityFor: string | null = null;
let identityPromise: Promise<boolean> | null = null;

function readProfileSnapshot(): TalkMeProfileSnapshot {
  const raw = getVpnTalkmeProfileRaw();
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as TalkMeProfileSnapshot) : {};
  } catch {
    return {};
  }
}

/** Chatwoot custom attributes: the same data Talk-Me receives as custom fields. */
export function buildChatwootAttributes(): Record<string, string> {
  const profile = readProfileSnapshot();
  const fields = buildTalkMeCustomFields(profile);
  const attrs: Record<string, string> = {
    tariff: fields.Tariff ?? "—",
    devices: fields.Devices ?? "—",
    traffic: fields.Traffic ?? "—",
    site: CHATWOOT_SITE,
  };
  const expireAt = typeof profile.expireAt === "string" ? profile.expireAt.trim() : "";
  if (expireAt) attrs.expire_at = expireAt;
  return attrs;
}

async function fetchAndSetChatwootUser(email: string): Promise<boolean> {
  const { data, error } = await apiGet<ChatIdentityResponse>("/chat/identity");
  if (identityFor !== email) return false; // logged out meanwhile
  if (error || !data?.identifier) return false;
  setChatwootUser({
    identifier: data.identifier,
    email: data.email || email,
    name: data.name || email,
    identifierHash: data.identifier_hash ?? null,
  });
  return true;
}

/** Resolves true once setUser has been queued for this email. */
function identifyChatwootUser(email: string): Promise<boolean> {
  if (identityFor === email && identityPromise) return identityPromise;
  identityFor = email;
  const promise = fetchAndSetChatwootUser(email)
    .catch(() => false)
    .then((ok) => {
      if (!ok && identityPromise === promise) {
        identityFor = null;
        identityPromise = null;
      }
      return ok;
    });
  identityPromise = promise;
  return promise;
}

/**
 * Chatwoot: loads the widget in the background and attaches the user's identity and profile attributes.
 * Talk-Me: no-op (the /chat page manages Talk-Me itself). Safe to call repeatedly.
 */
export function prepareSupportChat(options: SupportChatOptions = {}): void {
  if (getSupportChatProvider() !== "chatwoot") return;
  const email = options.email?.trim() || "";
  ensureChatwootScript();
  if (!email) return;
  // Attributes go to the identified contact, so they are sent after setUser.
  void identifyChatwootUser(email).then((ok) => {
    if (ok && identityFor === email) setChatwootCustomAttributes(buildChatwootAttributes());
  });
}

/** Opens the chat. Returns false if it could not be opened (the caller may fall back to email). */
export function openSupportChat(options: SupportChatOptions = {}): boolean {
  if (getSupportChatProvider() === "talkme") {
    openTalkMeChat({
      email: options.email?.trim() || undefined,
      custom: buildTalkMeCustomFields(readProfileSnapshot()),
    });
    return true;
  }
  prepareSupportChat(options);
  return openChatwoot();
}

/** Call on logout so the next user on this browser does not see the previous conversation. */
export function resetSupportChat(): void {
  identityFor = null;
  identityPromise = null;
  if (getSupportChatProvider() === "chatwoot") resetChatwoot();
}
