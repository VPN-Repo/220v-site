import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { OTP_MAX_TRIES } from "../config.mjs";
import { redis, isMockRedis } from "../redis.mjs";
import { credentialKey, passwordOtpKey, sessionKey } from "./keys.mjs";
import { hashCode } from "./crypto.mjs";

const scrypt = promisify(scryptCallback);
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const DUMMY_SALT = Buffer.alloc(16).toString("hex");

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, Buffer.from(salt, "hex"), 64, SCRYPT_OPTIONS);
  return { salt, hash: hash.toString("hex") };
}

export async function verifyPassword(password, credential) {
  const salt = credential?.salt && /^[0-9a-f]{32}$/.test(credential.salt) ? credential.salt : DUMMY_SALT;
  const actual = await scrypt(password, Buffer.from(salt, "hex"), 64, SCRYPT_OPTIONS);
  const expected = credential?.hash && /^[0-9a-f]{128}$/.test(credential.hash)
    ? Buffer.from(credential.hash, "hex") : Buffer.alloc(64);
  return Boolean(credential?.hash) && timingSafeEqual(actual, expected);
}

export async function getCredential(email) {
  const raw = await redis.get(credentialKey(email));
  if (!raw) return null;
  const credential = JSON.parse(raw);
  if (!credential || typeof credential.userUuid !== "string" || !Number.isSafeInteger(credential.version)
    || credential.version < 1 || !/^[0-9a-f]{32}$/.test(credential.salt)
    || !/^[0-9a-f]{128}$/.test(credential.hash)) {
    throw new Error("Invalid stored credential");
  }
  return credential;
}

/** Version 0 means "no password"; every set/change bumps it and revokes older sessions. */
export const credentialVersion = (credential) => credential?.version ?? 0;

// Conditional Redis scripts keep credential revisions and session creation in one transaction.
const SAVE_LOGIN_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local version = 0
if raw then
  local item = cjson.decode(raw)
  version = tonumber(item.version)
  if item.userUuid ~= ARGV[2] then return 'identity_changed' end
end
if version ~= tonumber(ARGV[1]) then return 'version_changed' end
redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[4]))
return 'ok'
`;

const INITIAL_PASSWORD_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'already_set' end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[3]))
return 'ok'
`;

const CHANGE_PASSWORD_SCRIPT = `
local sessionRaw = redis.call('GET', KEYS[2])
if not sessionRaw then return 'session_missing' end
local session = cjson.decode(sessionRaw)
if session.email ~= ARGV[1] then return 'session_missing' end
local credRaw = redis.call('GET', KEYS[1])
local version = 0
if credRaw then
  local credential = cjson.decode(credRaw)
  version = tonumber(credential.version)
  if credential.userUuid ~= session.userUuid then return 'identity_changed' end
end
if (tonumber(session.authVersion) or 0) ~= version then return 'version_changed' end
local otpRaw = redis.call('GET', KEYS[3])
if not otpRaw then return 'missing' end
local otp = cjson.decode(otpRaw)
if tonumber(otp.authVersion) ~= version then
  redis.call('DEL', KEYS[3]); return 'version_changed'
end
local different = string.len(otp.hash) ~= string.len(ARGV[2])
if not different then
  local diff = 0
  for i = 1, string.len(ARGV[2]) do
    diff = bit.bor(diff, bit.bxor(string.byte(otp.hash, i), string.byte(ARGV[2], i)))
  end
  different = diff ~= 0
end
if different then
  otp.tries = (tonumber(otp.tries) or 0) + 1
  if otp.tries >= tonumber(ARGV[4]) then redis.call('DEL', KEYS[3]); return 'too_many_tries' end
  redis.call('SET', KEYS[3], cjson.encode(otp), 'KEEPTTL')
  return 'bad_code'
end
local next = cjson.decode(ARGV[3])
next.version = version + 1
next.userUuid = session.userUuid
session.authVersion = next.version
redis.call('SET', KEYS[1], cjson.encode(next))
redis.call('SET', KEYS[2], cjson.encode(session), 'KEEPTTL')
redis.call('DEL', KEYS[3])
return 'ok'
`;

export async function saveLoginSession(email, userUuid, expectedVersion, sid, session, ttlSec) {
  if (isMockRedis) {
    const current = await getCredential(email);
    if (current && current.userUuid !== userUuid) return "identity_changed";
    if (credentialVersion(current) !== expectedVersion) return "version_changed";
    await redis.set(sessionKey(sid), JSON.stringify(session), "EX", ttlSec);
    return "ok";
  }
  return redis.eval(SAVE_LOGIN_SCRIPT, 2, credentialKey(email), sessionKey(sid),
    expectedVersion, userUuid, JSON.stringify(session), ttlSec);
}

export async function saveInitialPassword(email, sid, credential, session, ttlSec) {
  if (isMockRedis) {
    if (await redis.exists(credentialKey(email))) return "already_set";
    await redis.set(credentialKey(email), JSON.stringify(credential));
    await redis.set(sessionKey(sid), JSON.stringify(session), "EX", ttlSec);
    return "ok";
  }
  return redis.eval(INITIAL_PASSWORD_SCRIPT, 2, credentialKey(email), sessionKey(sid),
    JSON.stringify(credential), JSON.stringify(session), ttlSec);
}

export async function changePassword(email, sid, code, hashed) {
  if (isMockRedis) {
    const sessionRaw = await redis.get(sessionKey(sid));
    if (!sessionRaw) return "session_missing";
    const session = JSON.parse(sessionRaw);
    if (session.email !== email) return "session_missing";
    const credential = await getCredential(email);
    if (credential && credential.userUuid !== session.userUuid) return "identity_changed";
    const version = credentialVersion(credential);
    if ((session.authVersion ?? 0) !== version) return "version_changed";
    const raw = await redis.get(passwordOtpKey(sid));
    if (!raw) return "missing";
    const otp = JSON.parse(raw);
    if (otp.authVersion !== version) { await redis.del(passwordOtpKey(sid)); return "version_changed"; }
    if (otp.hash !== hashCode(code)) {
      otp.tries += 1;
      if (otp.tries >= OTP_MAX_TRIES) { await redis.del(passwordOtpKey(sid)); return "too_many_tries"; }
      const ttl = await redis.ttl(passwordOtpKey(sid));
      if (ttl > 0) await redis.set(passwordOtpKey(sid), JSON.stringify(otp), "EX", ttl);
      return "bad_code";
    }
    const next = { ...hashed, userUuid: session.userUuid, version: version + 1 };
    await redis.set(credentialKey(email), JSON.stringify(next));
    const ttl = await redis.ttl(sessionKey(sid));
    await redis.set(sessionKey(sid), JSON.stringify({ ...session, authVersion: next.version }), "EX", ttl > 0 ? ttl : 60);
    await redis.del(passwordOtpKey(sid));
    return "ok";
  }
  return redis.eval(CHANGE_PASSWORD_SCRIPT, 3, credentialKey(email), sessionKey(sid),
    passwordOtpKey(sid), email, hashCode(code), JSON.stringify(hashed), OTP_MAX_TRIES);
}

// Support-assigned password: bumps the credential version so every existing session is revoked.
const ADMIN_SET_PASSWORD_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local version = 0
if raw then version = tonumber(cjson.decode(raw).version) or 0 end
local next = cjson.decode(ARGV[1])
next.version = version + 1
redis.call('SET', KEYS[1], cjson.encode(next))
return next.version
`;

export async function adminSetPassword(email, userUuid, hashed) {
  const next = { ...hashed, userUuid };
  if (isMockRedis) {
    const raw = await redis.get(credentialKey(email));
    const version = (raw ? Number(JSON.parse(raw).version) || 0 : 0) + 1;
    await redis.set(credentialKey(email), JSON.stringify({ ...next, version }));
    return version;
  }
  return Number(await redis.eval(ADMIN_SET_PASSWORD_SCRIPT, 1, credentialKey(email), JSON.stringify(next)));
}
