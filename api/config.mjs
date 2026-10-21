export const isProd = process.env.NODE_ENV === "production";
export const COOKIE_SECURE =
  process.env.COOKIE_SECURE === "true" ||
  (process.env.COOKIE_SECURE !== "false" && isProd);
export const SESSION_COOKIE = "v220_sid";
export const CSRF_COOKIE = "v220_csrf";
// Binds the browser to its pending login code (holds the OTP owner token).
export const OTP_PENDING_COOKIE = "v220_otp_pending";
export const SESSION_TTL_SEC = 60 * 24 * 60 * 60;
export const SESSION_SLIDE_SEC = 30 * 24 * 60 * 60;
export const OTP_TTL_SEC = 10 * 60;
export const OTP_COOLDOWN_SEC = 30;
// Window in which a repeated OTP email counts as a resend and goes through the backup SMTP.
export const OTP_PROVIDER_WINDOW_SEC = 15 * 60;
export const OTP_MAX_TRIES = 5;
export const FETCH_TIMEOUT_MS = 8000;
export const AUTH_EVENT_LIST_KEY = "v220:auth:events";
export const AUTH_STATS_TYPE_KEY = "v220:auth:stats:type";
export const AUTH_STATS_IP_KEY = "v220:auth:stats:ip";
export const AUTH_STATS_EMAIL_KEY = "v220:auth:stats:email";
const AUTH_EVENT_LIMIT_ENV = Number(process.env.AUTH_EVENT_LIMIT);
export const AUTH_EVENT_LIMIT =
  Number.isInteger(AUTH_EVENT_LIMIT_ENV) && AUTH_EVENT_LIMIT_ENV > 0
    ? AUTH_EVENT_LIMIT_ENV
    : 10000;
export const AUTH_STATS_TTL_SEC = 30 * 24 * 60 * 60;

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REF_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HWID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_ALLOWED_EMAIL_DOMAINS = [
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
  "aol.com", "live.com", "msn.com", "me.com", "mac.com", "googlemail.com", "ymail.com",
  "mail.ru", "yandex.ru", "ya.ru", "bk.ru", "inbox.ru", "list.ru", "rambler.ru", "internet.ru",
  "protonmail.com", "proton.me", "pm.me", "tutanota.com", "zoho.com",
  "comcast.net", "verizon.net", "gmx.com", "happ.su", "hop.su", "vk.com",
];

export const ALLOWED_EMAIL_DOMAINS = new Set(
  (process.env.ALLOWED_EMAIL_DOMAINS && process.env.ALLOWED_EMAIL_DOMAINS.trim()
    ? process.env.ALLOWED_EMAIL_DOMAINS.split(",")
    : DEFAULT_ALLOWED_EMAIL_DOMAINS
  )
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
);

export const REF_EVENT_LIMIT =
  Number.isInteger(Number(process.env.REF_EVENT_LIMIT)) && Number(process.env.REF_EVENT_LIMIT) > 0
    ? Number(process.env.REF_EVENT_LIMIT)
    : 20000;

export const REF_EVENT_TTL_SEC =
  Number.isInteger(Number(process.env.REF_EVENT_TTL_SEC)) && Number(process.env.REF_EVENT_TTL_SEC) > 0
    ? Number(process.env.REF_EVENT_TTL_SEC)
    : 31536000; // 365 days

const configuredIpHashSecret = process.env.IP_HASH_SECRET?.trim();
if (isProd && !configuredIpHashSecret) {
  throw new Error("IP_HASH_SECRET is required in production");
}
if (!isProd && process.env.NODE_ENV === "development" && !configuredIpHashSecret) {
  console.warn("IP_HASH_SECRET is not set; using development-only fallback");
}
export const IP_HASH_SECRET = configuredIpHashSecret || "default_ref_secret";
