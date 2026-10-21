// Unisender Go delivery feedback for login codes.
//
// Only resends go through Unisender (the backup SMTP). Each backup email is tagged
// with X-UNISENDER-GO global_metadata.brand, because one Unisender account serves
// several sites and webhook events carry no sender. The webhook stores bounces in
// Redis per address, and the login screen shows them as a soft warning: sending is
// never blocked.

import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { emailHash, maskEmail } from "../auth/crypto.mjs";
import { mailBounceKey } from "../auth/keys.mjs";
import { logger } from "../logger.mjs";
import { redis } from "../redis.mjs";
import { UNISENDER_BRAND } from "./unisenderBrand.mjs";

const gunzipAsync = promisify(gunzip);

export const WEBHOOK_PATH = "/api/webhooks/unisender";
export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;
// Unisender wants a 200 within 3 s; stop waiting for Redis a little earlier.
const WEBHOOK_WORK_BUDGET_MS = 2500;

export const CATEGORIES = Object.freeze({
  INVALID_ADDRESS: "invalid_address",
  MAILBOX_FULL: "mailbox_full",
  BLOCKED_OR_SPAM: "blocked_or_spam",
  UNSUBSCRIBED: "unsubscribed",
  TEMPORARY_RETRY: "temporary_retry",
  IGNORE: "ignore",
});

// Texts approved by the owner. Do not edit without approval.
export const CATEGORY_MESSAGES = Object.freeze({
  invalid_address: "Почтовый ящик не найден. Проверьте адрес на опечатки.",
  mailbox_full: "Ящик забит под завязку — освободите место и запросите код заново.",
  blocked_or_spam:
    "Почта отклоняет письмо или прячет в «Спам». Проверьте «Спам» или укажите другой адрес.",
  unsubscribed: "Вы отключили наши письма, поэтому коды не доходят. Поддержка поможет включить обратно.",
  temporary_retry: "Письмо в пути, ещё пара минут.",
});

const DAY_SEC = 24 * 60 * 60;
// Only these categories are stored; temporary_retry and ignore are only logged.
export const BOUNCE_TTL_SEC = Object.freeze({
  invalid_address: 30 * DAY_SEC,
  mailbox_full: 3 * DAY_SEC,
  blocked_or_spam: 7 * DAY_SEC,
  unsubscribed: 30 * DAY_SEC,
});

// delivery_info.delivery_status → category (Unisender docs, reference section 6).
const DELIVERY_STATUS_CATEGORY = Object.freeze({
  ok_accepted: "ignore",
  ok_sent: "ignore",
  ok_delivered: "ignore",
  ok_read: "ignore",
  ok_link_visited: "ignore",
  ok_resubscribed: "ignore",

  ok_spam_folder: "blocked_or_spam",
  ok_fbl: "unsubscribed",
  ok_unsubscribed: "unsubscribed",
  err_unsubscribed: "unsubscribed",

  err_will_retry: "temporary_retry",
  err_retry_letter: "temporary_retry",

  err_user_unknown: "invalid_address",
  err_user_inactive: "invalid_address",
  err_mailbox_discarded: "invalid_address",
  err_dest_invalid: "invalid_address",
  err_domain_inactive: "invalid_address",
  err_no_dns: "invalid_address",
  err_no_smtp: "invalid_address",

  err_mailbox_full: "mailbox_full",
  skip_dup_mailbox_full: "mailbox_full",

  err_spam_rejected: "blocked_or_spam",
  err_spam_skipped: "blocked_or_spam",
  err_spam_removed: "blocked_or_spam",
  err_blacklisted: "blocked_or_spam",
  err_unreachable: "blocked_or_spam",
  skip_dup_unreachable: "blocked_or_spam",
  err_not_available: "blocked_or_spam",
  err_skip_letter: "blocked_or_spam",
  skip_dup_temp_unreachable: "blocked_or_spam",
  err_destination_misconfigured: "blocked_or_spam",
  err_too_large: "blocked_or_spam",
  err_delivery_failed: "blocked_or_spam",
  err_giveup: "blocked_or_spam",
  err_unknown: "blocked_or_spam",
  not_sent: "blocked_or_spam",

  err_lost: "temporary_retry",
  err_internal: "temporary_retry",
  err_resend: "temporary_retry",
  err_src_invalid: "temporary_retry",
});

// Fallback by the top-level status when delivery_status is missing or unknown.
const STATUS_FALLBACK_CATEGORY = Object.freeze({
  soft_bounced: "temporary_retry",
  hard_bounced: "blocked_or_spam",
  spam: "blocked_or_spam",
  unsubscribed: "unsubscribed",
});

const own = (obj, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);

export function categorizeEmailStatus(status, deliveryStatus) {
  if (own(DELIVERY_STATUS_CATEGORY, deliveryStatus)) return DELIVERY_STATUS_CATEGORY[deliveryStatus];
  if (own(STATUS_FALLBACK_CATEGORY, status)) return STATUS_FALLBACK_CATEGORY[status];
  return CATEGORIES.IGNORE;
}

const DELIVERED_STATUSES = new Set(["delivered"]);
const DELIVERED_DELIVERY_STATUSES = new Set(["ok_delivered", "ok_read"]);

export function normalizeBounceEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function readUnisenderApiKey() {
  return (process.env.UNISENDER_API_KEY || "").trim();
}

/**
 * Checks the webhook `auth` field: md5 of the raw body with the auth value
 * replaced by the API key, compared in constant time.
 */
export function verifyUnisenderAuth(rawBody, receivedAuth, apiKey) {
  if (!apiKey || typeof rawBody !== "string") return false;
  if (typeof receivedAuth !== "string" || !/^[0-9a-f]{32}$/i.test(receivedAuth)) return false;
  // A replacer function, so `$` sequences in the key are not treated as patterns.
  const signed = rawBody.replace(receivedAuth, () => apiKey);
  const expected = createHash("md5").update(signed, "utf8").digest();
  const got = Buffer.from(receivedAuth.toLowerCase(), "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** The stored warning for an address, or null. */
export async function getDeliveryWarning(email) {
  const normalized = normalizeBounceEmail(email);
  if (!normalized) return null;
  const raw = await redis.get(mailBounceKey(normalized));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    const message = CATEGORY_MESSAGES[record?.category];
    return message ? { category: record.category, message } : null;
  } catch {
    return null;
  }
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(Object.assign(new Error("payload too large"), { status: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

async function decodeBody(buf, contentEncoding) {
  const encoding = String(contentEncoding || "").trim().toLowerCase();
  const gzipMagic = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (encoding === "gzip" || encoding === "x-gzip" || gzipMagic) {
    try {
      return await gunzipAsync(buf, { maxOutputLength: WEBHOOK_BODY_LIMIT_BYTES });
    } catch (err) {
      const tooLarge = err?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|buffer/i.test(err?.message || "");
      throw Object.assign(new Error("bad gzip body"), { status: tooLarge ? 413 : 400 });
    }
  }
  if (encoding && encoding !== "identity") {
    throw Object.assign(new Error("unsupported content encoding"), { status: 415 });
  }
  return buf;
}

/** Turns one webhook payload into Redis operations for this brand. */
export function planBounceUpdates(payload, { brand = UNISENDER_BRAND, now = Date.now() } = {}) {
  const ops = [];
  const groups = Array.isArray(payload?.events_by_user) ? payload.events_by_user : [];
  for (const group of groups) {
    const events = Array.isArray(group?.events) ? group.events : [];
    for (const event of events) {
      if (event?.event_name !== "transactional_email_status") continue;
      const data = event.event_data;
      if (!data || typeof data !== "object") continue;
      if (data.metadata?.brand !== brand) continue;
      const email = normalizeBounceEmail(data.email);
      if (!email) continue;
      const status = typeof data.status === "string" ? data.status : "";
      const deliveryStatus =
        typeof data.delivery_info?.delivery_status === "string" ? data.delivery_info.delivery_status : null;
      const category = categorizeEmailStatus(status, deliveryStatus);
      const ttlSec = BOUNCE_TTL_SEC[category];
      let action = "log";
      if (ttlSec) {
        action = "set";
      } else if (
        category === CATEGORIES.IGNORE &&
        (DELIVERED_STATUSES.has(status) || DELIVERED_DELIVERY_STATUSES.has(deliveryStatus))
      ) {
        action = "delete";
      }
      ops.push({
        action,
        email,
        status,
        deliveryStatus,
        category,
        ttlSec: ttlSec || null,
        record: action === "set" ? { category, deliveryStatus, at: new Date(now).toISOString() } : null,
      });
    }
  }
  return ops;
}

async function applyBounceUpdates(ops) {
  const writes = ops.filter((op) => op.action !== "log");
  if (writes.length === 0) return;
  // One round trip; order is kept, so the latest event for an address wins.
  const pipeline = redis.pipeline();
  for (const op of writes) {
    const key = mailBounceKey(op.email);
    if (op.action === "set") pipeline.set(key, JSON.stringify(op.record), "EX", op.ttlSec);
    else pipeline.del(key);
  }
  const results = await pipeline.exec();
  const failed = (results || []).find(([err]) => err);
  if (failed) throw failed[0];
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("webhook work timed out"), { code: "ETIMEOUT" })), ms);
    }),
  ]);
}

/**
 * GET answers 200 for Unisender's registration check; POST takes the events.
 * Mount it before express.json(): it reads the raw body itself (1 MB, gzip).
 */
export function createUnisenderWebhookRouter({ limiter, log = logger } = {}) {
  const router = Router();
  const guards = limiter ? [limiter] : [];

  router.get(WEBHOOK_PATH, ...guards, (_req, res) => {
    res.type("text/plain").send("ok");
  });

  router.post(WEBHOOK_PATH, ...guards, async (req, res) => {
    const apiKey = readUnisenderApiKey();
    if (!apiKey) {
      req.resume();
      return res.status(503).json({ error: "disabled" });
    }

    let rawBody;
    let payload;
    try {
      const buf = await decodeBody(
        await readRawBody(req, WEBHOOK_BODY_LIMIT_BYTES),
        req.headers["content-encoding"],
      );
      rawBody = buf.toString("utf8");
      payload = JSON.parse(rawBody);
    } catch (err) {
      const status = err?.status || 400;
      log.warn({ status, reason: err?.message }, "unisender webhook bad body");
      return res.status(status).json({ error: "bad request" });
    }

    if (!payload || typeof payload !== "object" || !verifyUnisenderAuth(rawBody, payload.auth, apiKey)) {
      log.warn({ retryCount: payload?.retry_count ?? null }, "unisender webhook auth mismatch");
      return res.status(403).json({ error: "forbidden" });
    }

    const ops = planBounceUpdates(payload);
    for (const op of ops) {
      log.info(
        {
          emailHash: emailHash(op.email),
          maskedEmail: maskEmail(op.email),
          status: op.status,
          deliveryStatus: op.deliveryStatus,
          category: op.category,
          action: op.action,
        },
        "unisender email status",
      );
    }
    try {
      await withTimeout(applyBounceUpdates(ops), WEBHOOK_WORK_BUDGET_MS);
    } catch (err) {
      // Still 200: the data is a soft hint, and failed calls would get the webhook stopped.
      log.error({ err: { message: err?.message, code: err?.code } }, "unisender webhook redis update failed");
    }
    return res.type("text/plain").send("ok");
  });

  return router;
}
