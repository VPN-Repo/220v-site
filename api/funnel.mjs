// Site funnel counters: which steps visitors reach, per day, with no third-party service.
// The same file is copied unchanged into every brand site (Master, 220v, Leto and Pavel);
// the brand passes its Redis key prefix to installFunnel().
//
// What is stored, per Moscow day: a count per event (Redis hash) and an approximate number of
// distinct visitors per event (HyperLogLog over a random id the browser keeps in localStorage).
// No email, no IP, no user agent, no page URL. Keys expire after 100 days.
//
//   POST /api/events          { e: "<event>", v: "<visitor id>" }   → 204 (browser, same origin)
//   GET  /api/admin/funnel    ?days=14                               → admin token, per-day table
//   recordFunnel("<event>")   server-side steps (code sent, login, checkout), from any module

/** Every event the site may send. Anything else is ignored. */
export const FUNNEL_EVENTS = [
  // Landing
  "landing_view",
  "landing_cta",
  "login_open",
  // Login (server side)
  "code_sent",
  "login_ok",
  // Cabinet
  "dashboard_view",
  "instructions_open",
  "install_click",
  "add_click",
  "copy_link",
  "qr_open",
  "device_connected",
  // Payment
  "buy_open",
  "checkout_click",
  "checkout_created",
  "pay_success_view",
  "pay_fail_view",
  "support_open",
];

const EVENT_SET = new Set(FUNNEL_EVENTS);
const VISITOR_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TTL_SEC = 100 * 24 * 60 * 60;
const MAX_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const RATE = { max: 60, windowMs: 60_000 };

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function funnelDay(date = new Date()) {
  const parts = Object.fromEntries(dayFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The browser may send only from our own pages. */
function sameOrigin(req) {
  const site = String(req.get("Sec-Fetch-Site") || "").toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get("host");
  } catch {
    return false;
  }
}

let installed = null;

/** Server-side step (code sent, login, checkout). A no-op until installFunnel() ran. */
export function recordFunnel(event, visitor) {
  return installed ? installed(event, visitor) : Promise.resolve();
}

/**
 * @param {import("express").Express} app
 * @param {{ redis: object, prefix: string, requireAdminToken: Function, logger?: object, now?: () => Date }} deps
 */
export function installFunnel(app, { redis, prefix, requireAdminToken, logger, now = () => new Date() }) {
  const countKey = (day) => `${prefix}:funnel:${day}`;
  const visitorsKey = (day, event) => `${prefix}:funnel:${day}:v:${event}`;
  // Per-IP limit in memory only: the address is never written anywhere.
  const hits = new Map();
  const sweep = setInterval(() => {
    const t = Date.now();
    for (const [ip, entry] of hits) if (entry.until <= t) hits.delete(ip);
  }, RATE.windowMs);
  sweep.unref?.();

  function limited(ip) {
    const t = Date.now();
    const entry = hits.get(ip);
    if (!entry || entry.until <= t) {
      hits.set(ip, { count: 1, until: t + RATE.windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > RATE.max;
  }

  async function record(event, visitor) {
    if (!EVENT_SET.has(event)) return;
    const day = funnelDay(now());
    try {
      await redis.multi().hincrby(countKey(day), event, 1).expire(countKey(day), TTL_SEC).exec();
      // Separate from the count: a failure here never loses the count itself.
      if (visitor && VISITOR_RE.test(visitor)) {
        await redis.pfadd(visitorsKey(day, event), visitor);
        await redis.expire(visitorsKey(day, event), TTL_SEC);
      }
    } catch (err) {
      logger?.warn?.({ err, event }, "funnel record failed");
    }
  }

  app.post("/api/events", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const event = typeof req.body?.e === "string" ? req.body.e : "";
    const visitor = typeof req.body?.v === "string" ? req.body.v : "";
    // Always 204: a page never waits on or retries analytics.
    if (!EVENT_SET.has(event) || !sameOrigin(req) || limited(req.ip || "?")) return res.status(204).end();
    await record(event, visitor);
    return res.status(204).end();
  });

  app.get(
    "/api/admin/funnel",
    (_req, res, next) => {
      res.set("Cache-Control", "no-store");
      next();
    },
    requireAdminToken,
    async (req, res) => {
      const days = Math.min(MAX_DAYS, Math.max(1, Number.parseInt(String(req.query.days ?? "14"), 10) || 14));
      const today = Date.parse(`${funnelDay(now())}T00:00:00.000Z`);
      const list = Array.from({ length: days }, (_, i) => new Date(today - i * DAY_MS).toISOString().slice(0, 10));
      try {
        const rows = [];
        for (const day of list) {
          const counts = (await redis.hgetall(countKey(day))) || {};
          const visitors = {};
          await Promise.all(
            FUNNEL_EVENTS.map(async (event) => {
              visitors[event] = Number(await redis.pfcount(visitorsKey(day, event))) || 0;
            }),
          );
          const events = {};
          for (const event of FUNNEL_EVENTS) events[event] = { count: Number(counts[event]) || 0, visitors: visitors[event] };
          rows.push({ day, events });
        }
        return res.json({ events: FUNNEL_EVENTS, days: rows });
      } catch (err) {
        logger?.error?.({ err }, "funnel read failed");
        return res.status(502).json({ error: "Не удалось загрузить воронку" });
      }
    },
  );

  installed = record;
  return { recordFunnel: record };
}
