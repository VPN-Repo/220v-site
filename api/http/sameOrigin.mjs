// Login CSRF guard for the auth endpoints that work without a session (send-code,
// verify, verify-link, login-password, ...). Without it a foreign page could post
// its own code or link token and log the visitor into someone else's account.
// Today CORS (no Access-Control-* headers) and the JSON-only body parser already
// stop that; this makes it explicit instead of a side effect.
//
// Rules: JSON body only. Modern browsers send Sec-Fetch-Site, which must be
// same-origin (or none, e.g. a typed URL). Older ones send only Origin: its host
// must be the forwarded/request host or the site address from config (the proxy
// in front may rewrite Host).
import { LOGIN_LINK_ORIGIN } from "../config.mjs";

function originHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

export function requireSameOriginJson(req, res, next) {
  if (req.method !== "POST") return next();
  if (!req.is("application/json")) {
    return res.status(415).json({ error: "Некорректный запрос" });
  }
  const site = req.get("sec-fetch-site");
  if (site) {
    if (site === "same-origin" || site === "none") return next();
    req.log?.warn({ secFetchSite: site, path: req.path }, "cross-site auth request rejected");
    return res.status(403).json({ error: "Запрос отклонён" });
  }
  const origin = req.get("origin");
  if (!origin) return next();
  const host = originHost(origin);
  const allowed = new Set([req.get("x-forwarded-host"), req.get("host"), originHost(LOGIN_LINK_ORIGIN)].filter(Boolean));
  if (origin === "null" || !host || !allowed.has(host)) {
    req.log?.warn({ path: req.path }, "foreign origin auth request rejected");
    return res.status(403).json({ error: "Запрос отклонён" });
  }
  return next();
}
