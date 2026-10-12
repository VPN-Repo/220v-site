import {
  COOKIE_SECURE,
  CSRF_COOKIE,
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
