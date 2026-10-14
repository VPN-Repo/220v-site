import { randomBytes } from "node:crypto";
import {
  AUTH_EVENT_LIMIT,
  AUTH_EVENT_LIST_KEY,
  AUTH_STATS_EMAIL_KEY,
  AUTH_STATS_IP_KEY,
  AUTH_STATS_TTL_SEC,
  AUTH_STATS_TYPE_KEY,
} from "../config.mjs";
import { redis } from "../redis.mjs";
import { base64url, emailHash, maskEmail } from "./crypto.mjs";
import { KEY_PREFIXES, RL_PREFIXES, SCAN_PATTERNS } from "./keys.mjs";
import { buildDailyAuthSnapshot } from "./dailyStats.mjs";

function parseJsonObject(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function scanRedisKeys(pattern, limit = 500) {
  const keys = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0" && keys.length < limit);
  return keys.slice(0, limit).sort();
}

async function readRedisStringKey(key) {
  const [value, ttlSec, type] = await Promise.all([
    redis.get(key),
    redis.ttl(key),
    redis.type(key),
  ]);
  return {
    key,
    value,
    ttlSec,
    type,
    expiresAt: ttlSec > 0 ? new Date(Date.now() + ttlSec * 1000).toISOString() : null,
  };
}

function stripPrefix(key, prefix) {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function normalizeCounterEntries(raw) {
  return Object.entries(raw || {})
    .map(([key, value]) => ({ key, count: Number(value) || 0 }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 25);
}

export async function recordAuthEvent(type, req, fields = {}) {
  try {
    const email = typeof fields.email === "string" ? fields.email : "";
    const ip = req.ip || req.socket?.remoteAddress || "";
    const event = {
      id: base64url(randomBytes(8)),
      type,
      at: new Date().toISOString(),
      ip,
      userAgent: req.get("User-Agent") || "",
      path: req.path,
      emailHash: email ? emailHash(email) : undefined,
      emailMasked: email ? maskEmail(email) : undefined,
      userUuidPrefix:
        typeof fields.userUuid === "string" && fields.userUuid
          ? fields.userUuid.slice(0, 8)
          : undefined,
      status: typeof fields.status === "string" ? fields.status : undefined,
      detail: typeof fields.detail === "string" ? fields.detail : undefined,
      // OTP mail sends: which SMTP provider delivered the code (absent on other events).
      provider: typeof fields.provider === "string" ? fields.provider : undefined,
      failover: typeof fields.failover === "boolean" ? fields.failover : undefined,
    };

    await redis
      .multi()
      .lpush(AUTH_EVENT_LIST_KEY, JSON.stringify(event))
      .ltrim(AUTH_EVENT_LIST_KEY, 0, AUTH_EVENT_LIMIT - 1)
      .hincrby(AUTH_STATS_TYPE_KEY, type, 1)
      .expire(AUTH_STATS_TYPE_KEY, AUTH_STATS_TTL_SEC)
      .hincrby(AUTH_STATS_IP_KEY, ip || "unknown", 1)
      .expire(AUTH_STATS_IP_KEY, AUTH_STATS_TTL_SEC)
      .hincrby(AUTH_STATS_EMAIL_KEY, email ? emailHash(email) : "unknown", 1)
      .expire(AUTH_STATS_EMAIL_KEY, AUTH_STATS_TTL_SEC)
      .exec();
  } catch (err) {
    req.log?.debug({ err }, "auth event tracking failed");
  }
}

export async function findLatestSuccessfulSendCodeEvent(email) {
  const targetEmailHash = emailHash(email);
  const rawEvents = await redis.lrange(AUTH_EVENT_LIST_KEY, 0, AUTH_EVENT_LIMIT - 1);
  for (const raw of rawEvents) {
    const event = parseJsonObject(raw);
    if (
      event?.type === "send_code_sent" &&
      event?.status === "ok" &&
      event?.emailHash === targetEmailHash
    ) {
      const atMs = Date.parse(event.at);
      return {
        at: event.at,
        ageSec: Number.isFinite(atMs) ? Math.max(0, Math.floor((Date.now() - atMs) / 1000)) : null,
      };
    }
  }
  return null;
}

export async function buildRedisAuthSnapshot() {
  const [
    otpKeys,
    cooldownKeys,
    sessionKeys,
    sendCodeIpKeys,
    sendCodeEmailKeys,
    verifyIpKeys,
    checkoutSessionKeys,
    rawEvents,
    typeStats,
    ipStats,
    emailStats,
    dailyAuth,
  ] = await Promise.all([
    scanRedisKeys(SCAN_PATTERNS.otp),
    scanRedisKeys(SCAN_PATTERNS.otpCooldown),
    scanRedisKeys(SCAN_PATTERNS.session),
    scanRedisKeys(SCAN_PATTERNS.rlSendCodeIp),
    scanRedisKeys(SCAN_PATTERNS.rlSendCodeEmail),
    scanRedisKeys(SCAN_PATTERNS.rlVerifyIp),
    scanRedisKeys(SCAN_PATTERNS.rlCheckoutSid),
    redis.lrange(AUTH_EVENT_LIST_KEY, 0, AUTH_EVENT_LIMIT - 1),
    redis.hgetall(AUTH_STATS_TYPE_KEY),
    redis.hgetall(AUTH_STATS_IP_KEY),
    redis.hgetall(AUTH_STATS_EMAIL_KEY),
    buildDailyAuthSnapshot(),
  ]);

  const activeOtpKeys = otpKeys.filter((key) => !key.includes(":cooldown:"));
  const [otpEntries, cooldownEntries, sessionEntries, rateLimitEntries] = await Promise.all([
    Promise.all(activeOtpKeys.map(readRedisStringKey)),
    Promise.all(cooldownKeys.map(readRedisStringKey)),
    Promise.all(sessionKeys.map(readRedisStringKey)),
    Promise.all(
      [...sendCodeIpKeys, ...sendCodeEmailKeys, ...verifyIpKeys, ...checkoutSessionKeys].map(
        readRedisStringKey,
      ),
    ),
  ]);

  const rateLimitGroups = {
    sendCodeIp: new Set(sendCodeIpKeys),
    sendCodeEmail: new Set(sendCodeEmailKeys),
    verifyIp: new Set(verifyIpKeys),
    checkoutSession: new Set(checkoutSessionKeys),
  };

  const formatRateLimit = (entry, prefix) => ({
    key: entry.key,
    subject: stripPrefix(entry.key, prefix),
    count: Number(entry.value) || 0,
    ttlSec: entry.ttlSec,
    expiresAt: entry.expiresAt,
  });

  const formatOtp = (entry) => {
    const parsed = parseJsonObject(entry.value);
    const emailPart = stripPrefix(entry.key, KEY_PREFIXES.otp);
    return {
      key: entry.key,
      emailMasked: maskEmail(emailPart),
      emailHash: emailHash(emailPart),
      tries: Number(parsed?.tries) || 0,
      ttlSec: entry.ttlSec,
      expiresAt: entry.expiresAt,
    };
  };

  const formatCooldown = (entry) => {
    const emailPart = stripPrefix(entry.key, KEY_PREFIXES.otpCooldown);
    return {
      key: entry.key,
      emailMasked: maskEmail(emailPart),
      emailHash: emailHash(emailPart),
      ttlSec: entry.ttlSec,
      expiresAt: entry.expiresAt,
    };
  };

  const formatSession = (entry) => {
    const parsed = parseJsonObject(entry.value);
    return {
      key: entry.key,
      emailMasked: maskEmail(parsed?.email),
      emailHash: parsed?.email ? emailHash(parsed.email) : "",
      userUuidPrefix:
        typeof parsed?.userUuid === "string" ? parsed.userUuid.slice(0, 8) : "",
      expAt: typeof parsed?.expAt === "number" ? new Date(parsed.expAt).toISOString() : null,
      ttlSec: entry.ttlSec,
      expiresAt: entry.expiresAt,
    };
  };

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      otp: activeOtpKeys.length,
      cooldowns: cooldownKeys.length,
      sessions: sessionKeys.length,
      rateLimits:
        sendCodeIpKeys.length +
        sendCodeEmailKeys.length +
        verifyIpKeys.length +
        checkoutSessionKeys.length,
      events: rawEvents.length,
    },
    otp: otpEntries.map(formatOtp),
    cooldowns: cooldownEntries.map(formatCooldown),
    sessions: sessionEntries.map(formatSession),
    rateLimits: {
      sendCodeIp: rateLimitEntries
        .filter((entry) => rateLimitGroups.sendCodeIp.has(entry.key))
        .map((entry) => formatRateLimit(entry, RL_PREFIXES.sendCodeIp)),
      sendCodeEmail: rateLimitEntries
        .filter((entry) => rateLimitGroups.sendCodeEmail.has(entry.key))
        .map((entry) => formatRateLimit(entry, RL_PREFIXES.sendCodeEmail)),
      verifyIp: rateLimitEntries
        .filter((entry) => rateLimitGroups.verifyIp.has(entry.key))
        .map((entry) => formatRateLimit(entry, RL_PREFIXES.verifyIp)),
      checkoutSession: rateLimitEntries
        .filter((entry) => rateLimitGroups.checkoutSession.has(entry.key))
        .map((entry) => formatRateLimit(entry, RL_PREFIXES.checkoutSession)),
    },
    stats: {
      byType: normalizeCounterEntries(typeStats),
      byIp: normalizeCounterEntries(ipStats),
      byEmailHash: normalizeCounterEntries(emailStats),
    },
    dailyAuth,
    events: rawEvents.map((raw) => parseJsonObject(raw)).filter(Boolean),
  };
}
