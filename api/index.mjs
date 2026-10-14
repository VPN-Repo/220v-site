import "./env.mjs";
import { createHmac, randomBytes } from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { z } from "zod";

import { isProd, UUID_RE, REF_UUID_RE, HWID_RE } from "./config.mjs";
import { logger } from "./logger.mjs";
import { redis } from "./redis.mjs";
import { clientError, serverError } from "./http/errors.mjs";
import { fetchWithTimeout } from "./http/fetchWithTimeout.mjs";
import { isTimeoutError, publicMessageFromErr, timeoutStatusCode } from "./http/userMessages.mjs";
import {
  chatIdentityLimiter,
  checkoutSessionLimiter,
  emailUnsubscribeIpLimiter,
  refClickIpLimiter,
} from "./http/rateLimit.mjs";
import { recordReferralEvent, queryReferralEvents } from "./referrals/events.mjs";
import {
  buildReferralRiskForReferrer,
  buildReferralSummary,
  buildRegistrationRiskSignals,
} from "./referrals/summary.mjs";
import {
  closeReferralExchangeRequest,
  createReferralExchangeRequest,
  getPendingReferralExchangePoints,
  getReferralExchangeRequest,
  listReferralExchangeRequests,
  withReferralExchangeRequestLock,
  withReferralExchangeUserLock,
} from "./referrals/exchangeRequests.mjs";
import {
  emptyReferralUserStatus,
  getReferralUserStatus,
  getReferralUserStatuses,
  grantReferralExchangePermission,
  isReferralExchangeAllowed,
  isReferralUserPointsBlocked,
  recordReferralUserDebit,
  markReferralUserPointsBlocked,
  markReferralUserPointsUnblocked,
  revokeReferralExchangePermission,
} from "./referrals/userStatus.mjs";
import { SESSION_COOKIE } from "./config.mjs";
import { base64url, emailHash } from "./auth/crypto.mjs";
import { createAuthRouter } from "./auth/routes.mjs";
import { requireSession, getSession, requireAdminToken } from "./auth/session.mjs";
import { getCredential } from "./auth/password.mjs";
import { getMailerConfigSummary, sendOtpEmail, verifyMailerConfig } from "./mailer.mjs";
import { registerTalkMeRoutes } from "./talkme-routes.mjs";
import { trafficPurchaseRestriction } from "./billing/trafficEligibility.mjs";
import {
  UnsubscribeTokenConfigError,
  UnsubscribeTokenError,
  verifyUnsubscribeToken,
} from "./email/unsubscribeToken.mjs";

const app = express();
app.set("trust proxy", 1);
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/api/health" },
  }),
);
app.use(express.json({ limit: "16kb" }));
app.use(cookieParser());

function getBillingAllowedHosts() {
  const raw = process.env.BILLING_ALLOWED_HOSTS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

const BILLING_ALLOWED_HOSTS = getBillingAllowedHosts();

function isAllowedPaymentUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (BILLING_ALLOWED_HOSTS.size === 0) {
      return isProd ? false : true;
    }
    return BILLING_ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const checkoutSchema = z.object({
  product_key: z.enum(["sub_1m", "sub_6m", "sub_12m", "traffic_20gb", "traffic_50gb"]),
  payment_method: z.union([z.number().int(), z.string()]),
});
const applyPromoCodeSchema = z.object({
  promo_code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,64}$/),
});

const referralExchangeRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("days"),
    days: z.number().int().positive().max(365),
    points: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("prize"),
    prizeId: z.string().trim().min(1).max(80),
    prizeTitle: z.string().trim().min(1).max(160),
    details: z.string().trim().min(1).max(1000),
    points: z.number().int().positive(),
  }),
]);
const REFERRAL_POINTS_PER_DAY = 10;
const REFERRAL_EXCHANGE_PERMISSION_COMMENT_MAX = 1000;
const DEFAULT_EXCHANGE_APPROVE_COMMENT = "Обмен баллов пользователем";
const DEFAULT_EXCHANGE_REJECT_COMMENT = "Отклонено оператором";
const EMAIL_UNSUBSCRIBE_INVALID_LINK_MESSAGE = "Ссылка недействительна или устарела";
const EMAIL_UNSUBSCRIBE_UNAVAILABLE_MESSAGE = "Сервис отписки временно недоступен";
const EMAIL_UNSUBSCRIBE_REASONS = new Set([
  "too_many_emails",
  "not_relevant",
  "no_longer_use",
  "using_other_service",
  "other",
]);
const REFERRAL_PRIZES = new Map([
  ["airpods-3", { title: "Apple AirPods 3", points: 18000 }],
  ["phone-card-1000", { title: "1000 руб на баланс телефона или карту", points: 1000 }],
  ["phone-card-500", { title: "500 руб на баланс телефона или карту", points: 500 }],
]);

// --- Business constants (unchanged) ---

const MAX_DEVICES_ENV = Number(process.env.MAX_DEVICES);
const MAX_DEVICES = Number.isFinite(MAX_DEVICES_ENV) && MAX_DEVICES_ENV > 0 ? MAX_DEVICES_ENV : 0;
const BYTES_IN_GB = 1024 * 1024 * 1024;

function getTrafficLimitSubtractBytes() {
  const raw =
    process.env.TRAFFIC_LIMIT_SUBTRACT_GB ??
    process.env.VITE_TRAFFIC_LIMIT_SUBTRACT_GB ??
    "0";
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed * BYTES_IN_GB;
}

const TRAFFIC_LIMIT_SUBTRACT_BYTES = getTrafficLimitSubtractBytes();

function adjustTrafficLimitBytes(limitBytes) {
  const safeLimit = Number(limitBytes);
  if (!Number.isFinite(safeLimit) || safeLimit <= 0) return 0;
  return Math.max(0, safeLimit - TRAFFIC_LIMIT_SUBTRACT_BYTES);
}

const VALID_CHECKOUT_PRODUCTS = new Set([
  "sub_1m",
  "sub_6m",
  "sub_12m",
  "traffic_20gb",
  "traffic_50gb",
]);
const VALID_PAYMENT_METHOD_INTS = new Set([2, 11, 13]);

const PRODUCT_TO_TARIFF_KEY = {
  sub_1m: "basic_1m",
  sub_6m: "pro_6m",
  sub_12m: "premium_12m",
  traffic_20gb: "traffic_20gb",
  traffic_50gb: "traffic_50gb",
};

function normalizeCheckoutPaymentMethod(raw) {
  if (typeof raw === "number" && Number.isInteger(raw) && VALID_PAYMENT_METHOD_INTS.has(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    const legacy = { sbp: 2, card: 11, crypto: 13 };
    if (legacy[s] !== undefined) return legacy[s];
    const n = Number(s);
    if (Number.isInteger(n) && VALID_PAYMENT_METHOD_INTS.has(n)) return n;
  }
  return null;
}

function rmwBaseUrl() {
  return process.env.RMW_API_URL?.trim().replace(/\/$/, "") || "";
}

function rmwApiKey() {
  return process.env.RMW_API_KEY?.trim() || "";
}

function emailUnsubscribeSecret() {
  return process.env.EMAIL_UNSUBSCRIBE_SECRET?.trim() || "";
}

function paymentTypeToLabel(type) {
  const t = typeof type === "string" ? type.trim().toLowerCase() : "";
  if (t === "sbp") return "СБП (QR-код)";
  if (t === "card" || t === "carg") return "Оплата картой";
  if (t === "crypto") return "Криптовалюта";
  return t ? t : "Оплата";
}

const RMW_META_CACHE_TTL_MS = 5 * 60 * 1000;
const PROFILE_ENRICH_TIMEOUT_MS = 3_500;
let rmwMetaCache = { fetchedAtMs: 0, payments: null, products: null };
const rmwReferralUserCache = new Map();

async function fetchRmwJsonList({ rmwUrl, rmwKey, path }) {
  const r = await fetchWithTimeout(`${rmwUrl}${path}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": rmwKey,
    },
  });

  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON from RMW ${path}`);
  }

  if (!r.ok) {
    throw new Error(`RMW ${path} failed (${r.status})`);
  }

  if (!Array.isArray(data)) {
    throw new Error(`Unexpected response from RMW ${path}`);
  }

  return data;
}

function extractRmwUserEmail(payload) {
  if (!payload || typeof payload !== "object") return "";

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const email = extractRmwUserEmail(item);
      if (email) return email;
    }
    return "";
  }

  for (const key of ["email", "userEmail", "user_email"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  for (const key of ["user", "response", "data"]) {
    const email = extractRmwUserEmail(payload[key]);
    if (email) return email;
  }

  return "";
}

function extractRmwSubscription(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["user", "data", "response"]) {
    const nested = extractRmwSubscription(payload[key]);
    if (nested) return nested;
  }

  const plan = pickFirstString(
    payload.plan,
    displayPlanFromTariff(payload.tariff),
    displayPlanFromTariff(payload.tariff_key),
    payload.tariff,
    payload.tariff_key,
  );
  const expiresAt =
    safeDateParse(payload.expireAt) ||
    safeDateParse(payload.expire_at) ||
    safeDateParse(payload.expiresAt) ||
    safeDateParse(payload.expires_at);
  const status = pickFirstString(payload.tariff_state, payload.status);
  if (!plan && !expiresAt && !status) return null;
  return { plan: plan || null, expiresAt: expiresAt?.toISOString() || null, status: status || null };
}

async function fetchRmwReferralUser(userUuid, { fresh = false } = {}) {
  const uuid = assertValidUuid(userUuid);
  const cached = rmwReferralUserCache.get(uuid);
  const now = Date.now();
  if (!fresh && cached && now - cached.fetchedAtMs < RMW_META_CACHE_TTL_MS) {
    return cached.profile;
  }

  const rmwUrl = rmwBaseUrl();
  const rmwKey = rmwApiKey();
  if (!rmwUrl || !rmwKey) {
    const err = new Error("RMW not configured");
    err.status = 500;
    throw err;
  }

  const r = await fetchWithTimeout(
    `${rmwUrl}/v1/users/${encodeURIComponent(uuid)}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": rmwKey,
      },
    },
    PROFILE_ENRICH_TIMEOUT_MS,
  );

  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    const err = new Error("Invalid JSON from RMW");
    err.status = 502;
    throw err;
  }

  if (!r.ok) {
    const err = new Error("RMW user lookup failed");
    err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
    throw err;
  }

  const email = extractRmwUserEmail(data);
  const profile = { email, subscription: extractRmwSubscription(data) };
  rmwReferralUserCache.set(uuid, { fetchedAtMs: Date.now(), profile });
  return profile;
}

async function fetchRmwReferralPoints(userUuid, { page, limit }) {
  const uuid = assertValidUuid(userUuid);
  const rmwUrl = rmwBaseUrl();
  const rmwKey = rmwApiKey();
  if (!rmwUrl || !rmwKey) {
    const err = new Error("RMW not configured");
    err.status = 500;
    throw err;
  }

  const qs = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  const r = await fetchWithTimeout(
    `${rmwUrl}/v1/users/${encodeURIComponent(uuid)}/referral-points?${qs}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": rmwKey,
      },
    },
  );

  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    const err = new Error("Invalid JSON from RMW referral-points");
    err.status = 502;
    throw err;
  }

  if (!r.ok) {
    const err = new Error("RMW referral-points failed");
    err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
    throw err;
  }

  return data;
}

async function countRmwSuccessfulPayments(userUuid) {
  const uuid = assertValidUuid(userUuid);
  const rmwUrl = rmwBaseUrl();
  const rmwKey = rmwApiKey();
  if (!rmwUrl || !rmwKey) {
    const err = new Error("RMW not configured");
    err.status = 500;
    throw err;
  }

  const loadPage = async (page) => {
    const qs = new URLSearchParams({ page: String(page), limit: "100" });
    const response = await fetchWithTimeout(
      `${rmwUrl}/v1/users/${encodeURIComponent(uuid)}/transactions?${qs}`,
      { method: "GET", headers: { "Content-Type": "application/json", "X-Api-Key": rmwKey } },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !Array.isArray(body.items)) {
      const err = new Error("RMW transactions failed");
      err.status = response.ok ? 502 : response.status;
      throw err;
    }
    return body;
  };

  const first = await loadPage(1);
  const pageCount = Number(first.total_pages);
  if (!Number.isInteger(pageCount) || pageCount < 0 || pageCount > 1000) {
    const err = new Error("Invalid RMW transactions pagination");
    err.status = 502;
    throw err;
  }
  let count = first.items.filter((item) => item?.status === "CONFIRMED").length;
  for (let start = 2; start <= pageCount; start += 5) {
    const pages = await Promise.all(
      Array.from({ length: Math.min(5, pageCount - start + 1) }, (_, index) => loadPage(start + index)),
    );
    for (const page of pages) count += page.items.filter((item) => item?.status === "CONFIRMED").length;
  }
  return count;
}

async function debitRmwReferralPoints(userUuid, { amount, comment, force = false }) {
  const uuid = assertValidUuid(userUuid);
  const rmwUrl = rmwBaseUrl();
  const rmwKey = rmwApiKey();
  if (!rmwUrl || !rmwKey) {
    const err = new Error("RMW not configured");
    err.status = 500;
    throw err;
  }

  const payload = { amount, comment };
  if (force === true) {
    payload.force = true;
  }

  const r = await fetchWithTimeout(
    `${rmwUrl}/v1/users/${encodeURIComponent(uuid)}/referral-points/debit`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": rmwKey,
      },
      body: JSON.stringify(payload),
    },
  );

  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    const err = new Error("Invalid JSON from RMW referral-points debit");
    err.status = 502;
    throw err;
  }

  if (!r.ok) {
    const err = new Error("RMW referral-points debit failed");
    err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
    if (data && typeof data === "object" && typeof data.error === "string") {
      err.publicMessage = data.error;
    }
    throw err;
  }

  return data;
}

async function exchangeRmwReferralPointsForDays(userUuid, { points, days, force = false }) {
  const uuid = assertValidUuid(userUuid);
  const rmwUrl = rmwBaseUrl();
  const rmwKey = rmwApiKey();
  if (!rmwUrl || !rmwKey) {
    const err = new Error("RMW not configured");
    err.status = 500;
    throw err;
  }

  const r = await fetchWithTimeout(
    `${rmwUrl}/v1/users/${encodeURIComponent(uuid)}/referral-points/exchange-days`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": rmwKey,
      },
      body: JSON.stringify({ points, days, force }),
    },
  );

  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    const err = new Error("Invalid JSON from RMW referral-points exchange-days");
    err.status = 502;
    throw err;
  }

  if (!r.ok) {
    const err = new Error("RMW referral-points exchange-days failed");
    err.status = r.status >= 400 && r.status < 600 ? r.status : 502;
    if (data && typeof data === "object" && typeof data.error === "string") {
      err.publicMessage = data.error;
    }
    throw err;
  }

  return data;
}

function readEmailUnsubscribeRequest(body) {
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) {
    return { error: EMAIL_UNSUBSCRIBE_INVALID_LINK_MESSAGE };
  }

  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!EMAIL_UNSUBSCRIBE_REASONS.has(reason)) {
    return { error: "Укажите причину отписки" };
  }

  if (reason === "other") {
    const otherReason = typeof body?.otherReason === "string" ? body.otherReason.trim() : "";
    if (!otherReason || otherReason.length > 500) {
      return { error: "Укажите причину отписки" };
    }
  }

  if (body?.consent !== true) {
    return { error: "Подтвердите отписку" };
  }

  return { token };
}

async function unsubscribeRmwEmail(userUuid) {
  const uuid = assertValidUuid(userUuid);
  const rmwUrl = rmwBaseUrl();
  const rmwKey = rmwApiKey();
  if (!rmwUrl || !rmwKey) {
    const err = new Error("RMW not configured");
    err.publicMessage = EMAIL_UNSUBSCRIBE_UNAVAILABLE_MESSAGE;
    throw err;
  }

  const r = await fetchWithTimeout(`${rmwUrl}/v1/email/unsubscribe/${encodeURIComponent(uuid)}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": rmwKey,
    },
  });

  if (r.ok) return;

  const err = new Error(`RMW email unsubscribe failed (${r.status})`);
  if (r.status === 400 || r.status === 404) {
    err.status = 400;
    err.publicMessage = EMAIL_UNSUBSCRIBE_INVALID_LINK_MESSAGE;
    throw err;
  }
  err.publicMessage = EMAIL_UNSUBSCRIBE_UNAVAILABLE_MESSAGE;
  throw err;
}

function extractRmwTransactionId(data) {
  const raw =
    data?.transaction?.id ??
    data?.transactionId ??
    data?.transaction_id ??
    data?.id ??
    null;
  if (raw === null || raw === undefined || raw === "") return "";
  return String(raw);
}

// Manual accrual blocking and high anti-fraud risk both close the exchange.
// An active exchange permission overrides this, but never the accrual block itself.
function isReferralExchangeRestricted(status, risk) {
  return status.pointsBlocked || risk.riskLevel === "critical" || risk.riskLevel === "high";
}

function readExchangeRequestComment(body, fallback) {
  const raw =
    typeof body?.comment === "string"
      ? body.comment
      : typeof body?.operatorComment === "string"
        ? body.operatorComment
        : "";
  const comment = raw.trim();
  return comment || fallback;
}

async function getRmwBillingMeta({ allowCache = true } = {}) {
  const rmwUrl = rmwBaseUrl();
  const rmwKey = rmwApiKey();
  if (!rmwUrl || !rmwKey) {
    throw new Error("RMW_API_URL and RMW_API_KEY are required");
  }

  const now = Date.now();
  if (
    allowCache &&
    rmwMetaCache.payments &&
    rmwMetaCache.products &&
    now - rmwMetaCache.fetchedAtMs < RMW_META_CACHE_TTL_MS
  ) {
    return rmwMetaCache;
  }

  const [paymentsRaw, productsRaw] = await Promise.all([
    fetchRmwJsonList({ rmwUrl, rmwKey, path: "/v1/payments/list" }),
    fetchRmwJsonList({ rmwUrl, rmwKey, path: "/v1/products/list" }),
  ]);

  const payments = paymentsRaw
    .map((p) => ({
      id: typeof p?.id === "number" ? p.id : Number(p?.id),
      type: typeof p?.type === "string" ? p.type : "",
    }))
    .filter((p) => Number.isInteger(p.id) && p.id > 0 && p.type);

  const products = productsRaw
    .map((p) => ({
      name: typeof p?.name === "string" ? p.name : "",
      price: typeof p?.price === "number" ? p.price : Number(p?.price),
      duration: typeof p?.duration === "string" ? p.duration : "",
      traffic_limit_bytes:
        typeof p?.traffic_limit_bytes === "number"
          ? p.traffic_limit_bytes
          : Number(p?.traffic_limit_bytes ?? 0),
      type: typeof p?.type === "string" ? p.type : "",
    }))
    .filter((p) => p.name && Number.isFinite(p.price));

  rmwMetaCache = { fetchedAtMs: now, payments, products };
  return rmwMetaCache;
}

function getBillingRedirectUrls() {
  const success = process.env.BILLING_SUCCESS_URL?.trim();
  const cancel = process.env.BILLING_CANCEL_URL?.trim();
  if (success && cancel) return { successUrl: success, cancelUrl: cancel };
  const base = (process.env.PUBLIC_SITE_URL?.trim() || "https://220v.shop").replace(/\/$/, "");
  return {
    successUrl: `${base}/pay/success`,
    cancelUrl: `${base}/pay/fail`,
  };
}

function isValidHttpsUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function assertValidUuid(uuid) {
  if (!uuid || typeof uuid !== "string" || !UUID_RE.test(uuid.trim())) {
    throw new Error("Invalid user UUID");
  }
  return uuid.trim();
}

async function fetchRmwHwidDevices(rmwUrl, rmwKey, userUuid, timeoutMs) {
  const uuid = assertValidUuid(userUuid);
  if (!rmwUrl || !rmwKey) return null;
  try {
    const r = await fetchWithTimeout(
      `${rmwUrl}/v1/hwid/devices/${encodeURIComponent(uuid)}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": rmwKey,
        },
      },
      timeoutMs,
    );
    if (!r.ok) return null;
    const data = await r.json();
    const deviceList = Array.isArray(data.devices) ? data.devices : [];
    const total = typeof data.total === "number" ? data.total : deviceList.length;
    return { devices: deviceList, total };
  } catch {
    return null;
  }
}

async function applyRmwDeviceCount(rmwUrl, rmwKey, userUuid, userResponse, timeoutMs) {
  const hw = await fetchRmwHwidDevices(rmwUrl, rmwKey, userUuid, timeoutMs);
  if (hw && userResponse?.user) {
    userResponse.user.currentDevices = hw.total;
  }
}

async function enrichSubscriptionUrlFromPanel(baseUrl, headers, existingUser, userResponse, timeoutMs) {
  const short = existingUser.shortUuid || existingUser.short_uuid;
  if (!short) return;
  try {
    const subRes = await fetchWithTimeout(
      `${baseUrl}/api/subscriptions/by-uuid/${short}`,
      {
        method: "GET",
        headers,
      },
      timeoutMs,
    );
    if (subRes.ok) {
      const subData = await subRes.json();
      const sub = subData.response || subData;
      const subscriptionUrl = extractSubscriptionUrl(sub);
      if (subscriptionUrl) userResponse.user.subscriptionUrl = subscriptionUrl;
    }
  } catch {
    // ignore
  }
}

function safeDateParse(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function extractSubscriptionUrl(payload) {
  if (!payload) return "";

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nestedUrl = extractSubscriptionUrl(item);
      if (nestedUrl) return nestedUrl;
    }
    return "";
  }

  if (typeof payload !== "object") return "";

  const directUrl = pickFirstString(
    payload.subscriptionUrl,
    payload.subscription_url,
    payload.subscriptionLink,
    payload.subscription_link,
    payload.link,
    payload.url,
    payload.uri,
  );

  if (directUrl) return directUrl;

  for (const value of Object.values(payload)) {
    const nestedUrl = extractSubscriptionUrl(value);
    if (nestedUrl) return nestedUrl;
  }

  return "";
}

/** Подпись тарифа в ЛК (поле tariff из RMW) */
function displayPlanFromTariff(tariff) {
  if (!tariff || typeof tariff !== "string") return null;
  const t = tariff.trim().toLowerCase();
  const map = {
    trial: "Тестовый",
    "1month": "1 Месяц",
    "6month": "6 Месяцев",
    "12month": "12 Месяцев",
    basic_1m: "Базовый — 1 месяц",
    basic_6m: "Базовый — 6 месяцев",
    pro_6m: "Pro — 6 месяцев",
    premium_12m: "Premium — 12 месяцев",
  };
  return map[t] ?? null;
}

function buildUserResponse(user, exists) {
  const expireAt =
    safeDateParse(user.expireAt) ||
    safeDateParse(user.expire_at) ||
    safeDateParse(user.expiresAt) ||
    safeDateParse(user.expires_at);
  const createdAt = safeDateParse(user.createdAt) || safeDateParse(user.created_at) || new Date();
  const now = new Date();
  const daysLeft = expireAt
    ? Math.ceil((expireAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    : 0;
  const usedDays = Math.ceil((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
  const rawTariff = typeof user.tariff === "string" ? user.tariff.trim() : "";
  const fromTariff = displayPlanFromTariff(rawTariff);
  const plan = fromTariff ?? (daysLeft <= 1 ? "Test" : "Premium");

  const apiDeviceLimit = Number(user.hwidDeviceLimit ?? 0);
  const devicesLimit = MAX_DEVICES > 0 ? MAX_DEVICES : apiDeviceLimit;

  return {
    exists,
    user: {
      plan,
      ...(rawTariff ? { tariff: rawTariff } : {}),
      status: user.status || "ACTIVE",
      devicesLimit,
      currentDevices: 0,
      usedDays,
      expireAt: expireAt ? expireAt.toISOString() : new Date().toISOString(),
      daysLeft,
      username: user.username,
      userUuid: user.uuid || user.userUuid,
      shortUuid: user.shortUuid || user.short_uuid,
      inviter_uuid: user.inviterUuid || user.inviter_uuid || null,
      subscriptionUrl: extractSubscriptionUrl(user),
      usedTrafficBytes:
        user.usedTrafficBytes ??
        user.used_traffic_bytes ??
        (typeof user.userTraffic === "object" ? user.userTraffic.usedTrafficBytes : undefined) ??
        0,
      trafficLimitBytes: adjustTrafficLimitBytes(
        user.trafficLimitBytes ?? user.traffic_limit_bytes ?? 0,
      ),
    },
  };
}

function isDashboardUserPayload(data) {
  if (!data || typeof data !== "object" || typeof data.exists !== "boolean") return false;
  const u = data.user;
  if (!u || typeof u !== "object") return false;
  const hasUuid = typeof u.userUuid === "string" && u.userUuid.length > 0;
  const hasPlan = typeof u.plan === "string" && u.plan.length > 0;
  const hasTariff = typeof u.tariff === "string" && u.tariff.length > 0;
  return hasUuid && (hasPlan || hasTariff);
}

function applyTariffLabelToDashboardUser(user) {
  if (!user || typeof user !== "object") return;
  const label = displayPlanFromTariff(user.tariff);
  if (label) user.plan = label;
}

function extractPanelUserFromRmwSession(data) {
  if (!data || typeof data !== "object") return null;

  let exists = typeof data.exists === "boolean" ? data.exists : true;
  let user = null;

  if (data.user && typeof data.user === "object") {
    if (data.user.uuid) {
      user = data.user;
    } else if (data.user.userUuid) {
      user = { ...data.user, uuid: data.user.userUuid };
    }
  }

  if (!user && data.response !== undefined) {
    const r = data.response;
    if (Array.isArray(r)) {
      user = r.find((u) => u?.status === "ACTIVE") || r[r.length - 1] || null;
      exists = Boolean(user);
    } else if (r && typeof r === "object" && r.uuid) {
      user = r;
    }
  }

  if (!user && data.uuid) {
    user = data;
    exists = true;
  }

  return user?.uuid || user?.userUuid ? { panelUser: user, exists } : null;
}

async function fetchRmwAnnouncementText() {
  const rmwUrl = rmwBaseUrl();
  const rmwKey = rmwApiKey();
  if (!rmwUrl || !rmwKey) return null;

  const r = await fetchWithTimeout(`${rmwUrl}/announcement`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": rmwKey,
    },
  });

  const raw = await r.text();
  if (!r.ok || !raw?.trim()) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (data && typeof data === "object" && typeof data.text === "string") {
    const t = data.text.trim();
    return t || null;
  }
  return null;
}

/**
 * enrich=false skips device-count / subscription-URL lookups when only the
 * account identity is needed (e.g. support assigning a password).
 */
async function loadUserProfileForEmail(normalizedEmail, req, refUuid, { enrich = true } = {}) {
  const rmwUrl = rmwBaseUrl();
  const rmwKey = rmwApiKey();
  if (!rmwUrl || !rmwKey) {
    throw new Error("RMW not configured");
  }

  const baseUrl = process.env.REMNAWAVE_URL || "https://remna.2oo.uk";
  const token = process.env.REMNAWAVE_TOKEN;
  const panelHeaders = token
    ? {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      }
    : null;

  const sessionBody = { email: normalizedEmail };
  if (refUuid && typeof refUuid === "string" && REF_UUID_RE.test(refUuid.trim())) {
    sessionBody.ref_uuid = refUuid.trim();
  }

  const sessionRes = await fetchWithTimeout(`${rmwUrl}/v1/auth/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": rmwKey,
    },
    body: JSON.stringify(sessionBody),
  });

  const sessionText = await sessionRes.text();
  let sessionData;
  try {
    sessionData = sessionText ? JSON.parse(sessionText) : {};
  } catch {
    const err = new Error("Invalid JSON from RMW");
    err.status = 502;
    throw err;
  }

  if (!sessionRes.ok) {
    const err = new Error("RMW auth/session failed");
    err.status =
      sessionRes.status >= 400 && sessionRes.status < 600 ? sessionRes.status : 502;
    throw err;
  }

  if (isDashboardUserPayload(sessionData)) {
    if (!enrich) return sessionData;
    await applyRmwDeviceCount(
      rmwUrl,
      rmwKey,
      sessionData.user.userUuid,
      sessionData,
      PROFILE_ENRICH_TIMEOUT_MS,
    );
    applyTariffLabelToDashboardUser(sessionData.user);
    return sessionData;
  }

  const extracted = extractPanelUserFromRmwSession(sessionData);
  if (!extracted?.panelUser) {
    const err = new Error("RMW returned no user");
    err.status = 502;
    throw err;
  }

  const { panelUser, exists } = extracted;
  const userResponse = buildUserResponse(panelUser, exists);
  const uuid = userResponse.user.userUuid;
  if (!enrich) return userResponse;
  const enrichTasks = [
    applyRmwDeviceCount(rmwUrl, rmwKey, uuid, userResponse, PROFILE_ENRICH_TIMEOUT_MS),
  ];
  if (token && panelHeaders) {
    enrichTasks.push(
      enrichSubscriptionUrlFromPanel(
        baseUrl,
        panelHeaders,
        panelUser,
        userResponse,
        PROFILE_ENRICH_TIMEOUT_MS,
      ),
    );
  }
  await Promise.all(enrichTasks);
  return userResponse;
}

function extractUserUuidFromProfile(profile) {
  const u = profile?.user;
  const uuid = u?.userUuid || u?.uuid;
  if (!uuid || !UUID_RE.test(String(uuid).trim())) return null;
  return String(uuid).trim();
}

app.use(
  createAuthRouter({
    mailer: { sendOtpEmail },
    loadUserProfile: loadUserProfileForEmail,
    extractUserUuid: extractUserUuidFromProfile,
    isReferralPointsBlocked: isReferralUserPointsBlocked,
  }),
);

// --- Routes ---

app.post("/api/ref/click", refClickIpLimiter, async (req, res) => {
  try {
    const { ref_uuid, fingerprint } = req.body || {};
    if (!ref_uuid || typeof ref_uuid !== "string" || !REF_UUID_RE.test(ref_uuid.trim())) {
      return clientError(res, 400, "Некорректный реферальный код");
    }

    const referrerUuid = ref_uuid.trim();
    let otherUserUuidPrefix;
    let selfReferral = false;

    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) {
      const session = await getSession(sid);
      if (session && typeof session.userUuid === "string" && session.userUuid) {
        const currentUserUuid = session.userUuid.trim();
        otherUserUuidPrefix = currentUserUuid.slice(0, 8);
        selfReferral = currentUserUuid === referrerUuid;
      }
    }

    await recordReferralEvent("ref_click", req, {
      referrerUuid,
      fingerprint,
      otherUserUuidPrefix,
      selfReferral,
    });

    return res.sendStatus(204);
  } catch (err) {
    return serverError(res, req, err);
  }
});

app.get("/api/admin/referrals/events", requireAdminToken, async (req, res) => {
  try {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const filters = {
      referrerUuid: req.query.referrer_uuid || undefined,
      ip: req.query.ip || undefined,
      fingerprint: req.query.fingerprint || undefined,
      type: req.query.type || undefined,
      since: req.query.since || undefined,
      until: req.query.until || undefined,
      limit,
    };

    const events = await queryReferralEvents(filters);

    // Compute aggregations / stats for anti-fraud detection
    const ipCounts = {};
    const uaCounts = {};
    const fingerprintCounts = {};
    const referrerCounts = {};
    let multiAccountDetections = 0;
    let selfReferralDetections = 0;

    for (const event of events) {
      if (event.ipHash) {
        ipCounts[event.ipHash] = (ipCounts[event.ipHash] || 0) + 1;
      }
      if (event.uaHash) {
        uaCounts[event.uaHash] = (uaCounts[event.uaHash] || 0) + 1;
      }
      if (event.fingerprintHash) {
        fingerprintCounts[event.fingerprintHash] = (fingerprintCounts[event.fingerprintHash] || 0) + 1;
      }
      if (event.referrerUuid) {
        referrerCounts[event.referrerUuid] = (referrerCounts[event.referrerUuid] || 0) + 1;
      }
      if (event.otherUserUuidPrefix) {
        multiAccountDetections++;
      }
      if (event.selfReferral || event.type === "ref_self_referral") {
        selfReferralDetections++;
      }
    }

    const sortDesc = (obj) => Object.entries(obj)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const redactedEvents = events.map((event) => {
      const redacted = { ...event };
      delete redacted.ip;
      delete redacted.userAgent;
      delete redacted.fingerprint;
      return redacted;
    });

    return res.json({
      events: redactedEvents,
      stats: {
        total: events.length,
        multiAccountDetections,
        selfReferralDetections,
        topIps: sortDesc(ipCounts),
        topUserAgents: sortDesc(uaCounts),
        topFingerprints: sortDesc(fingerprintCounts),
        topReferrers: sortDesc(referrerCounts),
      }
    });
  } catch (err) {
    return serverError(res, req, err);
  }
});

app.get("/api/admin/referrals/summary", requireAdminToken, async (req, res) => {
  try {
    const rawDays = String(req.query.days || "30").trim().toLowerCase();
    const days = rawDays === "all" ? null : Number(rawDays);
    if (days !== null && (!Number.isInteger(days) || days <= 0)) {
      return clientError(res, 400, "Некорректный период");
    }

    const rawLimit = Number(req.query.limit);
    const limit =
      Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(20000, rawLimit) : 5000;

    const filters = { limit };
    if (days !== null) {
      filters.since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    }

    const events = await queryReferralEvents(filters);
    const summary = buildReferralSummary(events, { days, recentEventLimit: Math.min(200, limit) });
    const statuses = await getReferralUserStatuses(summary.referrers.map((item) => item.referrerUuid));
    summary.referrers = summary.referrers.map((item) => ({
      ...item,
      status: statuses[item.referrerUuid] || emptyReferralUserStatus(),
    }));
    return res.json(summary);
  } catch (err) {
    return serverError(res, req, err);
  }
});

app.get("/api/admin/referrals/exchange-requests", requireAdminToken, async (req, res) => {
  try {
    const status = String(req.query.status || "pending").trim();
    const items = await listReferralExchangeRequests({ status });
    return res.json({ items });
  } catch (err) {
    if (err.status === 400) {
      return clientError(res, 400, "Некорректный статус заявки");
    }
    return serverError(res, req, err);
  }
});

app.post("/api/admin/referrals/exchange-requests/:id/approve", requireAdminToken, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return clientError(res, 400, "Некорректный ID заявки");
    const operatorComment = readExchangeRequestComment(req.body, DEFAULT_EXCHANGE_APPROVE_COMMENT);
    const force = req.body?.force === true;

    const result = await withReferralExchangeRequestLock(id, async () => {
      const request = await getReferralExchangeRequest(id);
      if (!request) {
        const err = new Error("Exchange request not found");
        err.status = 404;
        throw err;
      }
      if (request.status !== "pending") {
        const err = new Error("Exchange request already closed");
        err.status = 409;
        throw err;
      }

      let rmwData;
      let responseField;
      if (request.type === "days") {
        const days = Number(request.payload?.days);
        if (!Number.isInteger(days) || days <= 0) {
          const err = new Error("Invalid exchange request days");
          err.status = 400;
          err.publicMessage = "Некорректное количество дней в заявке";
          throw err;
        }
        rmwData = await exchangeRmwReferralPointsForDays(request.referrerUuid, {
          points: request.points,
          days,
          force,
        });
        responseField = "exchange";
      } else {
        rmwData = await debitRmwReferralPoints(request.referrerUuid, {
          amount: request.points,
          comment: operatorComment,
          force,
        });
        responseField = "debit";
      }

      const closed = await closeReferralExchangeRequest(id, {
        status: "approved",
        operatorComment,
        rmwTransactionId: extractRmwTransactionId(rmwData),
      });
      return { request: closed, [responseField]: rmwData };
    });

    return res.json(result);
  } catch (err) {
    if (err.status === 404) {
      return clientError(res, 404, "Заявка не найдена");
    }
    if (err.status === 409) {
      return clientError(res, 409, "Заявка уже обработана или обрабатывается");
    }
    const status = err.status || 502;
    return clientError(res, status, err.publicMessage || "Не удалось одобрить заявку");
  }
});

app.post("/api/admin/referrals/exchange-requests/:id/reject", requireAdminToken, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return clientError(res, 400, "Некорректный ID заявки");
    const operatorComment = readExchangeRequestComment(req.body, DEFAULT_EXCHANGE_REJECT_COMMENT);

    const request = await withReferralExchangeRequestLock(id, async () => {
      const existing = await getReferralExchangeRequest(id);
      if (!existing) {
        const err = new Error("Exchange request not found");
        err.status = 404;
        throw err;
      }
      return closeReferralExchangeRequest(id, { status: "rejected", operatorComment });
    });

    return res.json({ request });
  } catch (err) {
    if (err.status === 404) {
      return clientError(res, 404, "Заявка не найдена");
    }
    if (err.status === 409) {
      return clientError(res, 409, "Заявка уже обработана или обрабатывается");
    }
    return serverError(res, req, err);
  }
});

app.get("/api/admin/referrals/users/:uuid", requireAdminToken, async (req, res) => {
  try {
    const uuid = assertValidUuid(req.params.uuid);
    const { email, subscription } = await fetchRmwReferralUser(uuid, { fresh: req.query.refresh === "1" });
    const status = await getReferralUserStatus(uuid);
    return res.json({ uuid, email: email || null, status, subscription });
  } catch (err) {
    if (err?.message === "Invalid user UUID") {
      return clientError(res, 400, "Некорректный UUID пользователя");
    }
    const status = err.status || 502;
    return clientError(res, status, "Не удалось загрузить данные пользователя из RMW");
  }
});

app.get("/api/admin/referrals/users/:uuid/successful-payments", requireAdminToken, async (req, res) => {
  try {
    const count = await countRmwSuccessfulPayments(req.params.uuid);
    return res.json({ count });
  } catch (err) {
    if (err?.message === "Invalid user UUID") {
      return clientError(res, 400, "Некорректный UUID пользователя");
    }
    return clientError(res, err.status || 502, "Не удалось загрузить количество успешных оплат");
  }
});

app.get("/api/admin/referrals/users/:uuid/points", requireAdminToken, async (req, res) => {
  try {
    const uuid = assertValidUuid(req.params.uuid);
    const pageRaw = Number(req.query.page);
    const limitRaw = Number(req.query.limit);
    const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit =
      Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(100, limitRaw) : 20;
    const data = await fetchRmwReferralPoints(uuid, { page, limit });

    // Attach UA/FP/IP risk signals from Redis referral events to registration
    // rows so the admin history shows which registrations shared fingerprints.
    try {
      const registrationItems = Array.isArray(data?.items)
        ? data.items.filter(
            (item) => item?.reason === "registration" && typeof item?.referred_user_email === "string",
          )
        : [];
      if (registrationItems.length > 0) {
        for (const item of registrationItems) {
          item.referred_email_hash = emailHash(item.referred_user_email.trim().toLowerCase());
        }
        const events = await queryReferralEvents({ referrerUuid: uuid, limit: 5000 });
        const riskByEmailHash = buildRegistrationRiskSignals(events, uuid);
        for (const item of registrationItems) {
          const hash = item.referred_email_hash;
          const risk = riskByEmailHash[hash];
          if (risk) item.risk = risk;
        }
      }
    } catch (err) {
      req.log.warn({ err }, "referral history risk enrichment failed");
    }

    return res.json(data);
  } catch (err) {
    if (err?.message === "Invalid user UUID") {
      return clientError(res, 400, "Некорректный UUID пользователя");
    }
    const status = err.status || 502;
    return clientError(res, status, "Не удалось загрузить историю рефералов из RMW");
  }
});

app.post("/api/admin/referrals/users/:uuid/points/debit", requireAdminToken, async (req, res) => {
  try {
    const uuid = assertValidUuid(req.params.uuid);
    const amountRaw = req.body?.amount;
    const amountProvided = amountRaw !== undefined && amountRaw !== null && String(amountRaw).trim() !== "";
    const amount = Number(amountRaw);
    const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
    const pointsBlocked = req.body?.pointsBlocked === true;
    const penalized = req.body?.penalized === true;
    const debitRequested = amountProvided || Boolean(comment);

    if (!debitRequested) {
      if (penalized) {
        return clientError(res, 400, "Для штрафа укажите количество баллов и причину списания");
      }
      const status = pointsBlocked
        ? await markReferralUserPointsBlocked(uuid)
        : await markReferralUserPointsUnblocked(uuid);
      return res.json({ status });
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      return clientError(res, 400, "Укажите положительное целое число баллов");
    }
    if (!comment) {
      return clientError(res, 400, "Укажите причину списания");
    }

    const data = await debitRmwReferralPoints(uuid, { amount, comment, force: req.body?.force === true });
    const status = await recordReferralUserDebit(uuid, { amount, comment, pointsBlocked, penalized });
    return res.json({ ...data, status });
  } catch (err) {
    if (err?.message === "Invalid user UUID") {
      return clientError(res, 400, "Некорректный UUID пользователя");
    }
    const status = err.status || 502;
    return clientError(res, status, err.publicMessage || "Не удалось списать реферальные баллы в RMW");
  }
});

app.post(
  "/api/admin/referrals/users/:uuid/exchange-permission",
  requireAdminToken,
  async (req, res) => {
    try {
      const uuid = assertValidUuid(req.params.uuid);
      const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
      if (!comment) {
        return clientError(res, 400, "Укажите комментарий к разрешению обмена");
      }
      if (comment.length > REFERRAL_EXCHANGE_PERMISSION_COMMENT_MAX) {
        return clientError(res, 400, "Комментарий к разрешению обмена слишком длинный");
      }

      const expiresAtRaw = typeof req.body?.expiresAt === "string" ? req.body.expiresAt.trim() : "";
      const expiresAtMs = expiresAtRaw ? Date.parse(expiresAtRaw) : Number.NaN;
      if (!Number.isFinite(expiresAtMs)) {
        return clientError(res, 400, "Укажите корректную дату окончания разрешения");
      }
      if (expiresAtMs <= Date.now()) {
        return clientError(res, 400, "Дата окончания разрешения должна быть в будущем");
      }

      const status = await grantReferralExchangePermission(uuid, {
        comment,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
      return res.json({ status });
    } catch (err) {
      if (err?.message === "Invalid user UUID") {
        return clientError(res, 400, "Некорректный UUID пользователя");
      }
      return serverError(res, req, err);
    }
  },
);

app.post(
  "/api/admin/referrals/users/:uuid/exchange-permission/revoke",
  requireAdminToken,
  async (req, res) => {
    try {
      const uuid = assertValidUuid(req.params.uuid);
      const status = await revokeReferralExchangePermission(uuid);
      return res.json({ status });
    } catch (err) {
      if (err?.message === "Invalid user UUID") {
        return clientError(res, 400, "Некорректный UUID пользователя");
      }
      return serverError(res, req, err);
    }
  },
);

app.get("/api/health", async (req, res) => {
  const redisStatus = redis.status;
  if (redisStatus !== "ready") {
    req.log.warn({ redisStatus }, "healthcheck redis not ready");
    return res.status(503).json({ ok: false, redisStatus });
  }

  try {
    await redis.ping();
    return res.json({ ok: true, redisStatus });
  } catch (err) {
    req.log.warn({ err, redisStatus: redis.status }, "healthcheck redis ping failed");
    return res.status(503).json({ ok: false, redisStatus: redis.status });
  }
});

app.post("/api/email/unsubscribe", emailUnsubscribeIpLimiter, async (req, res) => {
  try {
    const parsed = readEmailUnsubscribeRequest(req.body);
    if (parsed.error) {
      return clientError(res, 400, parsed.error);
    }

    let userUuid;
    try {
      userUuid = verifyUnsubscribeToken(parsed.token, emailUnsubscribeSecret());
    } catch (err) {
      if (err instanceof UnsubscribeTokenError) {
        return clientError(res, 400, EMAIL_UNSUBSCRIBE_INVALID_LINK_MESSAGE);
      }
      if (err instanceof UnsubscribeTokenConfigError) {
        err.publicMessage = EMAIL_UNSUBSCRIBE_UNAVAILABLE_MESSAGE;
      }
      throw err;
    }

    try {
      await unsubscribeRmwEmail(userUuid);
    } catch (err) {
      if (err.status === 400) {
        return clientError(res, 400, EMAIL_UNSUBSCRIBE_INVALID_LINK_MESSAGE);
      }
      throw err;
    }

    return res.json({ ok: true });
  } catch (err) {
    return serverError(res, req, err, EMAIL_UNSUBSCRIBE_UNAVAILABLE_MESSAGE);
  }
});

app.get("/api/announcement", async (_req, res) => {
  try {
    const envNotice = process.env.NOTICE?.trim();
    if (envNotice) {
      return res.json({ text: envNotice });
    }
    const text = await fetchRmwAnnouncementText();
    return res.json({ text: text ?? null });
  } catch {
    return res.json({ text: null });
  }
});

/**
 * Chatwoot identity validation: HMAC-SHA256(identifier) with the inbox HMAC token.
 * The token never leaves the server; without it identifier_hash is null.
 */
app.get("/api/chat/identity", requireSession, chatIdentityLimiter, (req, res) => {
  const identifier = req.session.userUuid;
  const token = process.env.CHATWOOT_HMAC_TOKEN?.trim();
  const identifierHash = token ? createHmac("sha256", token).update(identifier).digest("hex") : null;
  res.set("Cache-Control", "no-store");
  return res.json({
    identifier,
    identifier_hash: identifierHash,
    email: req.session.email,
    name: req.session.email,
  });
});

app.get("/api/me", requireSession, async (req, res) => {
  try {
    const [profile, credential] = await Promise.all([
      loadUserProfileForEmail(req.session.email, req),
      getCredential(req.session.email),
    ]);
    return res.json({ ...profile, email: req.session.email, hasPassword: Boolean(credential) });
  } catch (err) {
    const status = isTimeoutError(err) ? timeoutStatusCode(err) : err.status || 502;
    return clientError(
      res,
      status,
      publicMessageFromErr(err, "Не удалось загрузить профиль", { context: "профиль" }),
    );
  }
});

app.get("/api/me/referrals/status", requireSession, async (req, res) => {
  try {
    const userUuid = assertValidUuid(req.session.userUuid);
    const events = await queryReferralEvents({ referrerUuid: userUuid, limit: 5000 });
    const risk = buildReferralRiskForReferrer(events, userUuid);
    const status = await getReferralUserStatus(userUuid);
    const exchangeAllowed = isReferralExchangeAllowed(status);

    return res.json({
      riskLevel: risk.riskLevel,
      riskScore: risk.riskScore,
      blocked: isReferralExchangeRestricted(status, risk) && !exchangeAllowed,
      penalized: status.penalized,
      pointsBlocked: status.pointsBlocked,
      exchangeAllowed,
      warnings: risk.warnings,
      counts: risk.counts,
      lastSeen: risk.lastSeen,
      status,
    });
  } catch (err) {
    const status = err.status || 502;
    if (err?.message === "Invalid user UUID") {
      return clientError(res, 400, "Некорректный UUID пользователя");
    }
    req.log.warn({ err, status }, "referral status check failed");
    return clientError(res, status, "Не удалось проверить статус реферальной программы");
  }
});

app.get("/api/me/referrals/exchange-requests", requireSession, async (req, res) => {
  try {
    const userUuid = assertValidUuid(req.session.userUuid);
    const items = await listReferralExchangeRequests({ status: "user_visible", referrerUuid: userUuid });
    return res.json({ items });
  } catch (err) {
    if (err?.message === "Invalid user UUID") {
      return clientError(res, 400, "Некорректный UUID пользователя");
    }
    return serverError(res, req, err);
  }
});

app.post("/api/me/referrals/exchange-requests", requireSession, async (req, res) => {
  try {
    const userUuid = assertValidUuid(req.session.userUuid);
    const parsed = referralExchangeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return clientError(res, 400, "Некорректная заявка на обмен");
    }

    const requestInput = parsed.data;
    if (requestInput.type === "days" && requestInput.points !== requestInput.days * REFERRAL_POINTS_PER_DAY) {
      return clientError(res, 400, "Некорректная стоимость обмена дней");
    }
    const prize = requestInput.type === "prize" ? REFERRAL_PRIZES.get(requestInput.prizeId) : null;
    if (requestInput.type === "prize" && (!prize || requestInput.points !== prize.points)) {
      return clientError(res, 400, "Некорректный приз или стоимость обмена");
    }

    const events = await queryReferralEvents({ referrerUuid: userUuid, limit: 5000 });
    const risk = buildReferralRiskForReferrer(events, userUuid);
    const status = await getReferralUserStatus(userUuid);
    if (isReferralExchangeRestricted(status, risk) && !isReferralExchangeAllowed(status)) {
      return clientError(res, 403, "Списание/обмен баллов недоступны. Обратитесь в техническую поддержку.");
    }

    const rmwUrl = rmwBaseUrl();
    const rmwKey = rmwApiKey();
    if (!rmwUrl || !rmwKey) {
      return clientError(res, 500, "Сервис рефералов временно недоступен");
    }

    const request = await withReferralExchangeUserLock(userUuid, async () => {
      const pointsData = await fetchRmwReferralPoints(userUuid, { page: 1, limit: 1 });
      const balance = typeof pointsData?.balance === "number" ? pointsData.balance : 0;
      const pendingPoints = await getPendingReferralExchangePoints(userUuid);
      if (requestInput.points + pendingPoints > balance) {
        const err = new Error(
          `Недостаточно баллов с учетом активных заявок: нужно ${requestInput.points + pendingPoints}, доступно ${balance}.`,
        );
        err.status = 400;
        err.publicMessage = err.message;
        throw err;
      }

      const payload =
        requestInput.type === "days"
          ? { days: requestInput.days }
          : {
              prizeId: requestInput.prizeId,
              prizeTitle: prize.title,
              details: requestInput.details,
            };
      return createReferralExchangeRequest({
        referrerUuid: userUuid,
        email: req.session.email || "",
        type: requestInput.type,
        points: requestInput.points,
        payload,
      });
    });
    return res.status(201).json({ request });
  } catch (err) {
    const status = err.status || 502;
    if (err?.message === "Invalid user UUID") {
      return clientError(res, 400, "Некорректный UUID пользователя");
    }
    if (err.publicMessage) {
      return clientError(res, status, err.publicMessage);
    }
    req.log.warn({ err, status }, "referral exchange request failed");
    return clientError(res, status, "Не удалось создать заявку на обмен");
  }
});

app.get("/api/me/referrals/points", requireSession, async (req, res) => {
  try {
    const userUuid = assertValidUuid(req.session.userUuid);

    const pageRaw = Number(req.query.page);
    const limitRaw = Number(req.query.limit);
    const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit =
      Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(100, limitRaw) : 20;

    const rmwUrl = rmwBaseUrl();
    const rmwKey = rmwApiKey();
    if (!rmwUrl || !rmwKey) {
      return clientError(res, 500, "Сервис рефералов временно недоступен");
    }

    const data = await fetchRmwReferralPoints(userUuid, { page, limit });
    return res.json(data);
  } catch (err) {
    const status = err.status || 502;
    if (err?.message === "Invalid user UUID") {
      return clientError(res, 400, "Некорректный UUID пользователя");
    }
    req.log.warn({ err, status }, "RMW referral-points failed");
    return clientError(res, status, "Не удалось загрузить историю рефералов");
  }
});

app.get("/api/me/devices", requireSession, async (req, res) => {
  try {
    const userUuid = req.session.userUuid;
    assertValidUuid(userUuid);

    const rmwUrl = rmwBaseUrl();
    const rmwKey = rmwApiKey();
    if (rmwUrl && rmwKey) {
      const hw = await fetchRmwHwidDevices(rmwUrl, rmwKey, userUuid);
      if (hw) {
        return res.json({ devices: hw.devices, total: hw.total });
      }
      return clientError(res, 502, "Не удалось загрузить устройства");
    }

    const baseUrl = process.env.REMNAWAVE_URL || "https://remna.2oo.uk";
    const token = process.env.REMNAWAVE_TOKEN;
    if (!token) {
      return clientError(res, 500, "Сервис устройств временно недоступен");
    }

    const r = await fetchWithTimeout(`${baseUrl}/api/hwid/devices/${encodeURIComponent(userUuid)}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await r.json();
    const responseData = data.response || data;
    const deviceList = responseData.devices || (Array.isArray(responseData) ? responseData : []);
    return res.json({ devices: deviceList, total: responseData.total ?? deviceList.length });
  } catch (err) {
    return serverError(res, req, err);
  }
});

app.post("/api/me/promo-code/apply", requireSession, async (req, res) => {
  try {
    const parsed = applyPromoCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return clientError(res, 400, "Проверьте промокод и попробуйте ещё раз");
    }

    const userRef = assertValidUuid(req.session.userUuid);
    const rmwUrl = rmwBaseUrl();
    const rmwKey = rmwApiKey();
    if (!rmwUrl || !rmwKey) {
      return clientError(res, 500, "Активация промокода временно недоступна");
    }

    const r = await fetchWithTimeout(`${rmwUrl}/v1/billing/promo-code/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": rmwKey,
      },
      body: JSON.stringify({
        user_ref: userRef,
        promo_code: parsed.data.promo_code,
      }),
    });

    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      req.log.warn({ status: r.status }, "RMW promo apply returned invalid JSON");
      return clientError(res, 502, "Активация промокода временно недоступна");
    }

    if (!r.ok) {
      req.log.warn(
        { status: r.status, body: typeof data === "object" ? data : null },
        "RMW promo apply failed",
      );
      return clientError(
        res,
        r.status >= 500 ? 502 : r.status,
        "Промокод недействителен, уже использован или временно недоступен",
      );
    }

    const daysAdded = Number(data?.days_added);
    return res.json({
      ok: true,
      promo_code: typeof data?.promo_code === "string" ? data.promo_code : parsed.data.promo_code,
      days_added: Number.isFinite(daysAdded) ? daysAdded : 0,
      new_expire_at: typeof data?.new_expire_at === "string" ? data.new_expire_at : null,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      return clientError(
        res,
        timeoutStatusCode(err),
        publicMessageFromErr(err, "Активация промокода временно недоступна", { context: "промокод" }),
      );
    }
    return serverError(res, req, err, "Активация промокода временно недоступна");
  }
});

app.delete("/api/me/devices/:hwid", requireSession, async (req, res) => {
  try {
    const userUuid = req.session.userUuid;
    assertValidUuid(userUuid);

    const hwidValue = typeof req.params.hwid === "string" ? req.params.hwid.trim() : "";
    if (!HWID_RE.test(hwidValue)) {
      return clientError(res, 400, "Некорректный идентификатор устройства");
    }

    const rmwUrl = rmwBaseUrl();
    const rmwKey = rmwApiKey();
    if (rmwUrl && rmwKey) {
      const r = await fetchWithTimeout(`${rmwUrl}/v1/hwid/devices/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": rmwKey,
        },
        body: JSON.stringify({ userUuid, hwid: hwidValue }),
      });
      let data;
      try {
        data = await r.json();
      } catch {
        data = {};
      }
      return res.json({ success: r.ok, data: data.response ?? data });
    }

    const baseUrl = process.env.REMNAWAVE_URL || "https://remna.2oo.uk";
    const token = process.env.REMNAWAVE_TOKEN;
    if (!token) {
      return clientError(res, 500, "Сервис устройств временно недоступен");
    }

    const r = await fetchWithTimeout(`${baseUrl}/api/hwid/devices/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ uuid: hwidValue }),
    });
    const data = await r.json();
    return res.json({ success: r.ok, data: data.response || data });
  } catch (err) {
    return serverError(res, req, err);
  }
});

app.get("/api/billing/meta", async (req, res) => {
  try {
    const meta = await getRmwBillingMeta({ allowCache: true });
    const productKeys = Object.keys(PRODUCT_TO_TARIFF_KEY);
    const productsByName = new Map(meta.products.map((p) => [p.name, p]));

    const products = productKeys.map((product_key) => {
      const tariff_key = PRODUCT_TO_TARIFF_KEY[product_key];
      const rmwProduct = productsByName.get(tariff_key) || null;
      return {
        product_key,
        tariff_key,
        price: rmwProduct ? rmwProduct.price : null,
        duration: rmwProduct ? rmwProduct.duration : null,
        traffic_limit_bytes: rmwProduct ? rmwProduct.traffic_limit_bytes : null,
        type: rmwProduct ? rmwProduct.type : null,
      };
    });

    const payments = meta.payments.map((p) => ({
      id: p.id,
      type: p.type,
      label: paymentTypeToLabel(p.type),
    }));

    return res.json({
      fetchedAtMs: meta.fetchedAtMs,
      payments,
      products,
    });
  } catch (err) {
    req.log.error({ err }, "billing meta failed");
    return clientError(res, 502, "Сервис оплаты временно недоступен");
  }
});

app.post("/api/checkout", requireSession, checkoutSessionLimiter, async (req, res) => {
  try {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return clientError(res, 400, "Некорректный запрос на оплату");
    }

    const { product_key, payment_method } = parsed.data;
    if (!VALID_CHECKOUT_PRODUCTS.has(product_key)) {
      return clientError(res, 400, "Некорректный тариф");
    }

    const tariff_key = PRODUCT_TO_TARIFF_KEY[product_key];
    const pm = normalizeCheckoutPaymentMethod(payment_method);
    if (pm === null) {
      return clientError(res, 400, "Некорректный способ оплаты");
    }

    const ref = assertValidUuid(req.session.userUuid);

    const { successUrl: returnUrl, cancelUrl: failedUrl } = getBillingRedirectUrls();
    if (!isValidHttpsUrl(returnUrl) || !isValidHttpsUrl(failedUrl)) {
      return clientError(res, 500, "Оплата временно недоступна");
    }

    const rmwUrl = rmwBaseUrl();
    const rmwKey = rmwApiKey();
    if (!rmwUrl || !rmwKey) {
      return clientError(res, 500, "Оплата временно недоступна");
    }

    try {
      const meta = await getRmwBillingMeta({ allowCache: true });
      if (!meta.payments.some((p) => p.id === pm)) {
        return clientError(res, 400, "Этот способ оплаты не поддерживается");
      }
      if (!meta.products.some((p) => p.name === tariff_key)) {
        return clientError(res, 400, "Этот тариф не поддерживается");
      }
    } catch (err) {
      req.log.error({ err }, "billing meta validation failed");
      return clientError(res, 502, "Сервис оплаты временно недоступен");
    }

    let checkoutProfile;
    if (product_key.startsWith("traffic_")) {
      try {
        checkoutProfile = await loadUserProfileForEmail(req.session.email, req);
      } catch (err) {
        req.log.warn({ err }, "Failed to verify tariff for traffic checkout");
        return clientError(res, 502, "Не удалось проверить тариф. Попробуйте позже.");
      }
      if (extractUserUuidFromProfile(checkoutProfile) !== ref) {
        return clientError(res, 502, "Не удалось проверить тариф. Попробуйте позже.");
      }
      const restriction = trafficPurchaseRestriction(checkoutProfile.user);
      if (restriction) return clientError(res, 403, restriction);
    }

    const idempotencyKey = base64url(randomBytes(16));
    const payload = {
      user_ref: ref,
      tariff_key,
      payment_method: pm,
      return_url: returnUrl,
      failed_url: failedUrl,
    };

    const r = await fetchWithTimeout(`${rmwUrl}/v1/billing/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": rmwKey,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      return clientError(res, 502, "Сервис оплаты временно недоступен");
    }

    if (!r.ok) {
      req.log.warn({ status: r.status }, "RMW checkout failed");
      return clientError(res, r.status >= 400 && r.status < 600 ? r.status : 502, "Не удалось создать платёж");
    }

    const paymentUrl =
      data && typeof data === "object" && typeof data.payment_url === "string"
        ? data.payment_url
        : "";

    if (paymentUrl && !isAllowedPaymentUrl(paymentUrl)) {
      req.log.error({ paymentUrlHost: new URL(paymentUrl).hostname }, "payment_url host not allowed");
      return clientError(res, 502, "Получена некорректная ссылка на оплату");
    }

    try {
      const profile = checkoutProfile ?? await loadUserProfileForEmail(req.session.email, req);
      const inviterUuid = profile?.user?.inviter_uuid || profile?.user?.inviterUuid;
      if (inviterUuid) {
        await recordReferralEvent("ref_checkout_by_referred", req, {
          referrerUuid: inviterUuid,
          referredUuidPrefix: req.session.userUuid.slice(0, 8),
          tariffKey: tariff_key,
        });
      }
    } catch (err) {
      req.log.warn({ err }, "Failed to resolve inviter during checkout log");
    }

    return res.json(data);
  } catch (err) {
    return serverError(res, req, err);
  }
});

registerTalkMeRoutes(app);

export { app };

const port = Number(process.env.PORT) || 3001;

async function logMailerStartupStatus() {
  const summary = getMailerConfigSummary();
  if (!summary.ok) {
    logger.error({ mailer: summary }, "mailer config invalid at startup");
    return;
  }
  logger.info({ mailer: summary }, "mailer config loaded");
  try {
    await verifyMailerConfig();
    logger.info({ mailer: summary }, "mailer smtp connection verified");
  } catch (err) {
    logger.error({ err, mailer: summary }, "mailer smtp verify failed at startup");
  }
}

if (process.env.NODE_ENV !== "test") {
  void logMailerStartupStatus();

  app.listen(port, "0.0.0.0", () => {
    logger.info({ port, redisStatus: redis.status }, "API listening");
  });
}
