import { randomUUID } from "node:crypto";

import { redis } from "../redis.mjs";
import { refUserStatusKey } from "../auth/keys.mjs";

function normalizeBool(value) {
  return value === true || value === "1" || value === "true";
}

// The permission expires on its own: nothing rewrites the stored flag, so every
// read re-checks the deadline instead of relying on a background job.
function isExchangePermissionActive(exchangeAllowed, exchangeAllowedUntil, now = Date.now()) {
  if (!exchangeAllowed || !exchangeAllowedUntil) return false;
  const expiresAt = Date.parse(exchangeAllowedUntil);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function normalizeStatus(raw = {}) {
  const exchangeAllowed = normalizeBool(raw.exchangeAllowed);
  const exchangeAllowedUntil = raw.exchangeAllowedUntil || null;

  return {
    penalized: normalizeBool(raw.penalized),
    pointsBlocked: normalizeBool(raw.pointsBlocked),
    penalizedAt: raw.penalizedAt || null,
    pointsBlockedAt: raw.pointsBlockedAt || null,
    lastDebitAt: raw.lastDebitAt || null,
    lastDebitAmount: raw.lastDebitAmount ? Number(raw.lastDebitAmount) : null,
    lastDebitComment: raw.lastDebitComment || null,
    exchangeAllowed,
    exchangeAllowActive: isExchangePermissionActive(exchangeAllowed, exchangeAllowedUntil),
    exchangeAllowComment: raw.exchangeAllowComment || null,
    exchangeAllowedAt: raw.exchangeAllowedAt || null,
    exchangeAllowedUntil,
    exchangeAllowRevokedAt: raw.exchangeAllowRevokedAt || null,
    updatedAt: raw.updatedAt || null,
  };
}

export function emptyReferralUserStatus() {
  return normalizeStatus({});
}

export function isReferralExchangeAllowed(status) {
  return isExchangePermissionActive(status?.exchangeAllowed, status?.exchangeAllowedUntil);
}

export async function getReferralUserStatus(referrerUuid) {
  const raw = await redis.hgetall(refUserStatusKey(referrerUuid));
  return normalizeStatus(raw);
}

export async function getReferralUserStatuses(referrerUuids) {
  const uniqueUuids = [...new Set(referrerUuids.filter(Boolean))];
  if (uniqueUuids.length === 0) return {};

  const pipeline = redis.pipeline();
  for (const uuid of uniqueUuids) {
    pipeline.hgetall(refUserStatusKey(uuid));
  }
  const results = await pipeline.exec();

  return Object.fromEntries(
    uniqueUuids.map((uuid, index) => {
      const [, raw] = results[index] || [];
      return [uuid, normalizeStatus(raw || {})];
    }),
  );
}

export async function recordReferralUserDebit(referrerUuid, { amount, comment, pointsBlocked, penalized }) {
  const now = new Date().toISOString();
  const key = refUserStatusKey(referrerUuid);
  const existing = await redis.hgetall(key);
  const update = {
    penalized: penalized ? "1" : "0",
    updatedAt: now,
    lastDebitAt: now,
    lastDebitId: randomUUID(),
    lastDebitAmount: String(amount),
    lastDebitComment: comment,
  };

  if (penalized && (!normalizeBool(existing.penalized) || !existing.penalizedAt)) {
    update.penalizedAt = now;
  }

  if (pointsBlocked) {
    update.pointsBlocked = "1";
    if (!existing.pointsBlockedAt) {
      update.pointsBlockedAt = now;
    }
  }

  await redis.hset(key, update);
  if (!penalized) {
    await redis.hdel(key, "penalizedAt");
  }
  return getReferralUserStatus(referrerUuid);
}

export async function markReferralUserPointsBlocked(referrerUuid) {
  const now = new Date().toISOString();
  const key = refUserStatusKey(referrerUuid);
  const existing = await redis.hgetall(key);
  const update = {
    pointsBlocked: "1",
    updatedAt: now,
  };

  if (!existing.pointsBlockedAt) {
    update.pointsBlockedAt = now;
  }

  await redis.hset(key, update);
  return getReferralUserStatus(referrerUuid);
}

export async function markReferralUserPointsUnblocked(referrerUuid) {
  const now = new Date().toISOString();
  const key = refUserStatusKey(referrerUuid);

  await redis.hset(key, {
    pointsBlocked: "0",
    updatedAt: now,
  });
  await redis.hdel(key, "pointsBlockedAt");
  return getReferralUserStatus(referrerUuid);
}

export async function grantReferralExchangePermission(referrerUuid, { comment, expiresAt }) {
  const now = new Date().toISOString();
  const key = refUserStatusKey(referrerUuid);

  await redis.hset(key, {
    exchangeAllowed: "1",
    exchangeAllowComment: comment,
    exchangeAllowedAt: now,
    exchangeAllowedUntil: expiresAt,
    updatedAt: now,
  });
  await redis.hdel(key, "exchangeAllowRevokedAt");
  return getReferralUserStatus(referrerUuid);
}

export async function revokeReferralExchangePermission(referrerUuid) {
  const now = new Date().toISOString();

  // The comment and deadline stay in place as an audit trail of the revoked grant.
  await redis.hset(refUserStatusKey(referrerUuid), {
    exchangeAllowed: "0",
    exchangeAllowRevokedAt: now,
    updatedAt: now,
  });
  return getReferralUserStatus(referrerUuid);
}

export async function isReferralUserPointsBlocked(referrerUuid) {
  const value = await redis.hget(refUserStatusKey(referrerUuid), "pointsBlocked");
  return normalizeBool(value);
}
