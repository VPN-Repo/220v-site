import { timingSafeEqual } from "node:crypto";
import { OTP_COOLDOWN_SEC, OTP_MAX_TRIES, OTP_PROVIDER_WINDOW_SEC, OTP_TTL_SEC } from "../config.mjs";
import { redis, isMockRedis } from "../redis.mjs";
import { hashCode } from "./crypto.mjs";
import { otpCooldownKey, otpKey } from "./keys.mjs";

function parseOtpPayload(raw) {
  if (!raw || typeof raw !== "string") {
    return { parsed: null, status: "missing" };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { parsed: null, status: "non_object" };
    }
    return { parsed, status: "ok" };
  } catch {
    return { parsed: null, status: "invalid_json" };
  }
}

export async function acquireOtpCooldown(email, owner, ttlSec = OTP_COOLDOWN_SEC) {
  return redis.set(otpCooldownKey(email), owner, "EX", ttlSec, "NX");
}

// Seconds left on a resend cooldown key; at least 1 (the key may expire between the checks).
export async function cooldownRemainingSec(key) {
  const ttlSec = Number(await redis.ttl(key));
  return ttlSec > 0 ? ttlSec : 1;
}

/**
 * authVersion is the password credential version at issue time: a code sent
 * before a password set/change cannot be used to log in afterwards.
 */
export async function putOtp(email, codeHash, owner, authVersion = 0) {
  await redis.set(
    otpKey(email),
    JSON.stringify({ hash: codeHash, tries: 0, owner, authVersion }),
    "EX",
    OTP_TTL_SEC,
  );
}

export async function getOtpDebugSnapshot(email) {
  const key = otpKey(email);
  const [ttlSec, type] = await Promise.all([redis.ttl(key), redis.type(key)]);
  const raw = type === "string" ? await redis.get(key) : null;
  const { parsed, status } =
    type === "string"
      ? parseOtpPayload(raw)
      : { parsed: null, status: type === "none" ? "missing" : "wrong_type" };
  return {
    exists: type !== "none",
    ttlSec,
    type,
    tries: status === "ok" ? Number(parsed.tries) || 0 : undefined,
    hasOwner: status === "ok" ? typeof parsed.owner === "string" && parsed.owner.length > 0 : false,
    parseStatus: status,
  };
}

export async function getCooldownDebugSnapshot(email) {
  const key = otpCooldownKey(email);
  const [exists, ttlSec, type] = await Promise.all([redis.exists(key), redis.ttl(key), redis.type(key)]);
  return {
    exists: exists === 1,
    ttlSec,
    type,
  };
}

export async function clearOtpAndCooldown(email, owner) {
  if (isMockRedis) {
    // ioredis-mock has no cjson in Lua; same owner-checked cleanup in JS for tests.
    const { parsed } = parseOtpPayload(await redis.get(otpKey(email)));
    if (parsed?.owner === owner) await redis.del(otpKey(email));
    if ((await redis.get(otpCooldownKey(email))) === owner) await redis.del(otpCooldownKey(email));
    return;
  }
  await redis.eval(
    `
local otpKey = KEYS[1]
local cooldownKey = KEYS[2]
local owner = ARGV[1]
local rawOtp = redis.call("GET", otpKey)
if rawOtp then
  local ok, otp = pcall(cjson.decode, rawOtp)
  if ok and type(otp) == "table" and otp["owner"] == owner then
    redis.call("DEL", otpKey)
  end
end
if redis.call("GET", cooldownKey) == owner then
  redis.call("DEL", cooldownKey)
end
return 1
`,
    2,
    otpKey(email),
    otpCooldownKey(email),
    owner,
  );
}

/**
 * @returns {Promise<{ ok: true, authVersion: number } | { ok: false, reason: string, status: number, tries?: number }>}
 */
export async function verifyOtp(email, code) {
  const key = otpKey(email);
  const raw = await redis.get(key);
  if (!raw) {
    return { ok: false, reason: "missing", status: 400 };
  }

  let otp;
  try {
    otp = JSON.parse(raw);
  } catch {
    await redis.del(key);
    return { ok: false, reason: "corrupt", status: 400 };
  }

  const expectedHash = hashCode(code);
  const storedHash = otp.hash || "";
  const hashBufA = Buffer.from(expectedHash, "hex");
  const hashBufB = Buffer.from(storedHash, "hex");
  const codeOk =
    hashBufA.length === hashBufB.length &&
    hashBufA.length > 0 &&
    timingSafeEqual(hashBufA, hashBufB);

  if (!codeOk) {
    const tries = (otp.tries || 0) + 1;
    if (tries >= OTP_MAX_TRIES) {
      await redis.del(key);
      return { ok: false, reason: "too_many_tries", status: 410, tries };
    }
    await redis.set(key, JSON.stringify({ ...otp, tries }), "EX", OTP_TTL_SEC);
    return { ok: false, reason: "bad_code", status: 400, tries };
  }

  return { ok: true, authVersion: Number(otp.authVersion) || 0 };
}

export async function deleteOtp(email) {
  await redis.del(otpKey(email));
}

/**
 * @returns {Promise<{ ok: true, authVersion: number } | { ok: false, reason: string, status: number, tries?: number }>}
 */
export async function consumeOtp(email, code) {
  const result = await verifyOtp(email, code);
  if (!result.ok) return result;
  await deleteOtp(email);
  return result;
}

/**
 * Picks the SMTP provider for an OTP email from the number of successful sends
 * recorded under sendsKey: the first send in the window goes through the
 * primary provider (SES), every later one (a resend) through the backup.
 * The mailer itself falls back to primary when no backup is configured.
 *
 * @returns {Promise<"primary" | "backup">}
 */
export async function pickOtpMailProvider(sendsKey) {
  const sent = Number(await redis.get(sendsKey)) || 0;
  return sent > 0 ? "backup" : "primary";
}

/**
 * Counts a successful OTP email send. The window is fixed from the first send:
 * SET NX creates the counter with its TTL, INCR keeps that TTL.
 *
 * @returns {Promise<number | null>} which send this is in the window (1 for the first one)
 */
export async function recordOtpMailSend(sendsKey, windowSec = OTP_PROVIDER_WINDOW_SEC) {
  const results = await redis.multi().set(sendsKey, "0", "EX", windowSec, "NX").incr(sendsKey).exec();
  const sendNumber = Number(results?.[1]?.[1]);
  return Number.isInteger(sendNumber) && sendNumber > 0 ? sendNumber : null;
}
