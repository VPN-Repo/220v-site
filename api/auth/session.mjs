import {
  COOKIE_SECURE,
  CSRF_COOKIE,
  PROMO_PENDING_COOKIE,
  SESSION_COOKIE,
  SESSION_SLIDE_SEC,
  SESSION_TTL_SEC,
} from "../config.mjs";
import { redis } from "../redis.mjs";
import { clientError } from "../http/errors.mjs";
import { timingSafeEqualStr } from "./crypto.mjs";
import { sessionKey } from "./keys.mjs";
import { credentialVersion, getCredential } from "./password.mjs";

export function setSessionCookies(res, sid, csrf) {
  const common = {
    path: "/",
    sameSite: "lax",
    secure: COOKIE_SECURE,
  };
  res.cookie(SESSION_COOKIE, sid, {
    ...common,
    httpOnly: true,
    maxAge: SESSION_TTL_SEC * 1000,
  });
  res.cookie(CSRF_COOKIE, csrf, {
    ...common,
    httpOnly: false,
    maxAge: SESSION_TTL_SEC * 1000,
  });
}

export function clearSessionCookies(res) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.clearCookie(CSRF_COOKIE, { path: "/" });
  res.clearCookie(PROMO_PENDING_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: COOKIE_SECURE });
}

export async function getSession(sid) {
  if (!sid) return null;
  const raw = await redis.get(sessionKey(sid));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveSession(sid, data) {
  await redis.set(sessionKey(sid), JSON.stringify(data), "EX", SESSION_TTL_SEC);
}

export async function deleteSession(sid) {
  if (sid) await redis.del(sessionKey(sid));
}

export async function loadSession(req, res, next) {
  const sid = req.cookies?.[SESSION_COOKIE];
  const session = await getSession(sid);
  if (!session?.userUuid || !session?.email) {
    return clientError(res, 401, "Требуется авторизация");
  }

  const now = Date.now();
  if (session.expAt && now > session.expAt) {
    await deleteSession(sid);
    clearSessionCookies(res);
    return clientError(res, 401, "Сессия истекла");
  }

  // Setting or changing a password bumps the credential version and revokes
  // every session issued for an older version (or for another account UUID).
  let credential;
  try {
    credential = await getCredential(session.email);
  } catch (err) {
    req.log?.error({ err }, "session credential lookup failed");
    return clientError(res, 503, "Авторизация временно недоступна");
  }
  if (
    (Number(session.authVersion) || 0) !== credentialVersion(credential) ||
    (credential && credential.userUuid !== session.userUuid)
  ) {
    await deleteSession(sid);
    clearSessionCookies(res);
    return clientError(res, 401, "Сессия истекла");
  }

  await redis.expire(sessionKey(sid), SESSION_SLIDE_SEC);
  req.session = {
    sid,
    userUuid: session.userUuid,
    email: session.email,
    csrf: session.csrf,
    activePromo: session.activePromo,
  };
  return next();
}

export function requireCsrf(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }

  const headerToken = req.get("X-CSRF-Token") || "";
  const cookieToken = req.cookies?.[CSRF_COOKIE] || "";
  if (!headerToken || !cookieToken || !timingSafeEqualStr(headerToken, cookieToken)) {
    return clientError(res, 403, "Ошибка безопасности. Обновите страницу и попробуйте снова");
  }
  if (!timingSafeEqualStr(headerToken, req.session?.csrf)) {
    return clientError(res, 403, "Ошибка безопасности. Обновите страницу и попробуйте снова");
  }
  return next();
}

export const requireSession = [loadSession, requireCsrf];

export function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_REDIS_TOKEN?.trim();
  if (!expected) {
    return clientError(res, 503, "Просмотр Redis для администратора не настроен");
  }

  const auth = req.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const headerToken = req.get("X-Admin-Token") || "";
  const token = bearer || headerToken;

  if (!token || !timingSafeEqualStr(token, expected)) {
    return clientError(res, 401, "Требуется авторизация");
  }
  return next();
}

// Changes only the saved discount code, atomically, keeping the TTL and every other session field.
// With expectedPromo the update applies only to that exact saved version, so a checkout never
// drops a code that was saved again while it was running.
export async function updateSessionPromo(sid, promo, expectedPromo = null) {
  const key = sessionKey(sid);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = await redis.get(key);
    if (!raw) return 0;
    const session = JSON.parse(raw);
    if (expectedPromo && JSON.stringify(session.activePromo) !== JSON.stringify(expectedPromo)) return 0;
    if (promo) session.activePromo = promo;
    else delete session.activePromo;
    const saved = await redis.eval(
      `
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      local ttl = redis.call('TTL', KEYS[1])
      if ttl <= 0 then ttl = tonumber(ARGV[3]) end
      redis.call('SET', KEYS[1], ARGV[2], 'EX', ttl)
      return 1
      `,
      1,
      key,
      raw,
      JSON.stringify(session),
      SESSION_SLIDE_SEC,
    );
    if (saved) return 1;
  }
  throw new Error("Concurrent session updates did not settle");
}
