// Промоссылки ?pdays=CODE (бонусные дни) и ?psale=CODE (скидка на следующую оплату).
// Начисление дней, размер скидки и запрет повторного использования решает RMW;
// здесь только захват кода, его хранение до входа и привязка к серверной сессии.
// Описание поведения: docs/promocodes.md.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import { COOKIE_SECURE, PROMO_PENDING_COOKIE, isProd } from "./config.mjs";
import { redis } from "./redis.mjs";
import { getSession, requireSession, updateSessionPromo } from "./auth/session.mjs";
import { promoCaptureIpLimiter } from "./http/rateLimit.mjs";

const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax", secure: COOKIE_SECURE };

export const PROMO_APPLY_FAILED_MESSAGE = "Промокод недействителен, уже использован или временно недоступен";

export function normalizePromo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = typeof value.kind === "string" ? value.kind.trim().toLowerCase() : "";
  const raw = typeof value.promo_code === "string" ? value.promo_code : value.code;
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return (kind === "days" || kind === "sale") && code && code.length <= 64 ? { kind, code } : null;
}

// Public view of the saved discount; the internal version never leaves the server.
export function activePromo(session) {
  const promo = normalizePromo(session?.activePromo);
  return promo?.kind === "sale" ? { ...promo, activated_at: session.activePromo.activatedAt } : null;
}

function publicSiteOrigin() {
  try {
    const url = new URL(process.env.PUBLIC_SITE_URL?.trim() || "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

// Capture is open to guests, so only same-origin browser requests may set the pending cookie.
export function checkCaptureOrigin(req, res, next) {
  const site = req.get("Sec-Fetch-Site");
  const origin = req.get("Origin");
  let allowed = !site || site === "same-origin" || site === "none";
  if (origin) {
    try {
      const url = new URL(origin);
      // A proxy in front may replace Host with an upstream name. In that case trust only the
      // configured PUBLIC_SITE_URL origin, never X-Forwarded-Host or other client headers.
      const validOrigin = ["http:", "https:"].includes(url.protocol) && url.origin === origin;
      allowed = allowed && validOrigin && (url.host === req.get("Host") || url.origin === publicSiteOrigin());
    } catch {
      allowed = false;
    }
  } else if (isProd) {
    allowed = false;
  }
  if (!allowed) {
    return res.status(403).json({ code: "invalid_origin", error: "Запрос отклонён: неизвестный источник" });
  }
  return next();
}

export function resultKey(sid, candidate) {
  const digest = createHash("sha256").update(`${sid}\0${candidate.kind}\0${candidate.code}`).digest("hex");
  return `v220:promo:resolve-result:${digest}`;
}

export const lockKey = (sid) => `v220:promo:resolve-lock:${sid}`;

export async function releasePromoLock(key, token) {
  await redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
    1,
    key,
    token,
  );
}

function isValidDaysResponse(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || data.ok === false) return false;
  const days = data.days_added;
  if (typeof days !== "number" && typeof days !== "string") return false;
  if (typeof days === "string" && !days.trim()) return false;
  if (!Number.isFinite(Number(days)) || Number(days) < 0) return false;
  return [data.prev_expire_at, data.new_expire_at].every(
    (date) => date == null || (typeof date === "string" && Number.isFinite(Date.parse(date))),
  );
}

// The short lock and result cache absorb duplicate HTTP requests from one session;
// one-time redemption across sessions is enforced by RMW.
export async function processPromo(sid, candidate, applyDays, { waitMs = 9000, pollMs = 75 } = {}) {
  const key = lockKey(sid);
  const token = randomBytes(18).toString("base64url");
  const cacheKey = candidate.kind === "days" ? resultKey(sid, candidate) : null;
  const cached = async () => {
    const raw = cacheKey ? await redis.get(cacheKey) : null;
    return raw ? JSON.parse(raw) : null;
  };
  const deadline = Date.now() + waitMs;
  for (;;) {
    const hit = await cached();
    if (hit) return hit;
    if (await redis.set(key, token, "EX", 20, "NX")) break;
    if (Date.now() >= deadline) {
      return {
        httpStatus: 409,
        clearPending: false,
        body: { code: "promo_processing", error: "Промокод ещё применяется. Повторите чуть позже." },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    // The previous lock owner may have finished right before our SET NX.
    const hit = await cached();
    if (hit) return hit;
    const session = await getSession(sid);
    if (!session || (session.expAt && Date.now() > session.expAt)) {
      return { httpStatus: 401, clearPending: false, body: { error: "Требуется авторизация" } };
    }
    if (candidate.kind === "sale") {
      const promo = { ...candidate, activatedAt: new Date().toISOString(), version: randomUUID() };
      const saved = await updateSessionPromo(sid, promo);
      return saved
        ? {
            httpStatus: 200,
            clearPending: true,
            body: { ok: true, status: "pending_checkout_validation", promo: activePromo({ activePromo: promo }) },
          }
        : { httpStatus: 401, clearPending: false, body: { error: "Требуется авторизация" } };
    }
    let result;
    try {
      const response = await applyDays(session.userUuid, candidate.code);
      if (!response.ok) {
        result = { httpStatus: 400, clearPending: true, body: { code: "promo_apply_failed", error: PROMO_APPLY_FAILED_MESSAGE } };
      } else {
        const data = await response.json();
        // A malformed 2xx must not be reported as granted days.
        if (!isValidDaysResponse(data)) throw new Error("Invalid days promo response");
        await updateSessionPromo(sid, null);
        result = {
          httpStatus: 200,
          clearPending: true,
          body: {
            ok: true,
            status: "days_applied",
            promo_code: typeof data.promo_code === "string" ? data.promo_code : candidate.code,
            days_added: Number(data.days_added) || 0,
            prev_expire_at: data.prev_expire_at ?? null,
            new_expire_at: data.new_expire_at ?? null,
          },
        };
      }
    } catch {
      result = { httpStatus: 502, clearPending: true, body: { code: "promo_apply_failed", error: PROMO_APPLY_FAILED_MESSAGE } };
    }
    await redis.set(cacheKey, JSON.stringify(result), "EX", 60);
    return result;
  } finally {
    await releasePromoLock(key, token);
  }
}

export function createPromoRouter({ applyDays }) {
  const router = Router();

  router.post("/api/promo/capture", checkCaptureOrigin, promoCaptureIpLimiter, (req, res) => {
    const candidate = normalizePromo(req.body);
    if (!candidate) {
      return res.status(400).json({ code: "invalid_promo", error: "Ссылка с промокодом повреждена" });
    }
    res.cookie(PROMO_PENDING_COOKIE, JSON.stringify(candidate), { ...cookieOptions, maxAge: PENDING_MAX_AGE_MS });
    return res.json({ ok: true });
  });

  router.get("/api/promo/active", requireSession, (req, res) => {
    const promo = activePromo(req.session);
    return res.json({ active: Boolean(promo), promo });
  });

  // Empty body: resolve the pending cookie. A body with kind/promo_code: resolve that code
  // (manual discount form); an invalid body never falls back to the cookie.
  router.post("/api/promo/resolve", requireSession, async (req, res) => {
    try {
      const explicit =
        req.body != null &&
        (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length > 0);
      let candidate;
      if (explicit) {
        candidate = normalizePromo(req.body);
        if (!candidate) return res.status(400).json({ code: "invalid_promo", error: "Промокод указан неверно" });
      } else {
        try {
          candidate = normalizePromo(JSON.parse(req.cookies?.[PROMO_PENDING_COOKIE] || "null"));
        } catch {
          // the cookie is client-controlled; a broken value is simply dropped
        }
      }
      if (!candidate) {
        if (req.cookies?.[PROMO_PENDING_COOKIE]) res.clearCookie(PROMO_PENDING_COOKIE, cookieOptions);
        return res.json({ ok: true, status: "none" });
      }
      const result = await processPromo(req.session.sid, candidate, applyDays);
      if (result.clearPending) res.clearCookie(PROMO_PENDING_COOKIE, cookieOptions);
      return res.status(result.httpStatus).json(result.body);
    } catch (err) {
      req.log?.error({ err }, "promo resolve failed");
      return res.status(502).json({ code: "promo_apply_failed", error: PROMO_APPLY_FAILED_MESSAGE });
    }
  });

  return router;
}
