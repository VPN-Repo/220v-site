// The funnel counters (api/funnel.mjs). The same file is copied unchanged into every brand site.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";
const { redis, isMockRedis } = await import("../redis.mjs");
const { installFunnel, recordFunnel, funnelDay, FUNNEL_EVENTS } = await import("../funnel.mjs");

after(async () => {
  await redis.quit();
});

// ioredis-mock has no HyperLogLog: an exact set stands in for it in tests.
if (isMockRedis) {
  redis.pfadd = (key, ...members) => redis.sadd(key, ...members);
  redis.pfcount = (key) => redis.scard(key);
}

const TOKEN = "t".repeat(32);
const requireAdminToken = (req, res, next) => (req.get("X-Admin-Token") === TOKEN ? next() : res.status(401).json({ error: "no" }));
const day = funnelDay(new Date("2026-11-10T12:00:00Z"));

function makeApp(prefix) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "16kb" }));
  installFunnel(app, { redis, prefix, requireAdminToken, now: () => new Date("2026-11-10T12:00:00Z") });
  return app;
}

const visitor = (n) => `visitor-${String(n).padStart(12, "0")}`;
const send = (app, body, headers = {}) => request(app).post("/api/events").set(headers).send(body);

describe("funnel", () => {
  it("counts allowed events and distinct visitors per day", async () => {
    const app = makeApp("t1");
    await send(app, { e: "landing_view", v: visitor(1) }).expect(204);
    await send(app, { e: "landing_view", v: visitor(1) }).expect(204);
    await send(app, { e: "landing_view", v: visitor(2) }).expect(204);
    await send(app, { e: "dashboard_view", v: visitor(1) }).expect(204);
    assert.deepEqual(await redis.hgetall(`t1:funnel:${day}`), { landing_view: "3", dashboard_view: "1" });
    assert.equal(await redis.pfcount(`t1:funnel:${day}:v:landing_view`), 2);
    const ttl = await redis.ttl(`t1:funnel:${day}`);
    assert.ok(ttl > 90 * 86400 && ttl <= 100 * 86400, String(ttl));
  });

  it("ignores unknown events, bad visitor ids and other sites, always with 204; proxies may rewrite Host", async () => {
    const app = makeApp("t2");
    await send(app, { e: "drop_table", v: visitor(1) }).expect(204);
    await send(app, { e: "landing_view", v: "user@example.com" }).expect(204);
    await send(app, { e: "landing_view", v: visitor(3) }, { "Sec-Fetch-Site": "cross-site" }).expect(204);
    await send(app, { e: "landing_view", v: visitor(4) }, { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" }).expect(204);
    // Behind a proxy Host may differ from the page's origin (www vs bare domain): still counted.
    await send(app, { e: "qr_open", v: visitor(5) }, { "Sec-Fetch-Site": "same-site", Origin: "https://www.example.org", Host: "example.org" }).expect(204);
    await send(app, "not json").expect(204);
    assert.deepEqual(await redis.hgetall(`t2:funnel:${day}`), { landing_view: "1", qr_open: "1" }, "the bad-visitor event counts without a visitor; cross-site is dropped");
    assert.equal(await redis.pfcount(`t2:funnel:${day}:v:landing_view`), 0);
  });

  it("limits one address to 60 events a minute", async () => {
    const app = makeApp("t3");
    for (let i = 0; i < 70; i += 1) await send(app, { e: "qr_open", v: visitor(i) }, { "X-Forwarded-For": "198.51.100.7" });
    await send(app, { e: "qr_open", v: visitor(99) }, { "X-Forwarded-For": "198.51.100.8" });
    assert.equal(await redis.hget(`t3:funnel:${day}`, "qr_open"), "61");
  });

  it("server-side steps go through recordFunnel()", async () => {
    makeApp("t4");
    await recordFunnel("login_ok");
    await recordFunnel("not_an_event");
    assert.deepEqual(await redis.hgetall(`t4:funnel:${day}`), { login_ok: "1" });
  });

  it("the admin table needs the token and lists every event per day", async () => {
    const app = makeApp("t5");
    await send(app, { e: "buy_open", v: visitor(5) });
    await request(app).get("/api/admin/funnel").expect(401);
    const res = await request(app).get("/api/admin/funnel?days=3").set("X-Admin-Token", TOKEN).expect(200);
    assert.deepEqual(res.body.events, FUNNEL_EVENTS);
    assert.equal(res.body.days.length, 3);
    assert.equal(res.body.days[0].day, day);
    assert.deepEqual(res.body.days[0].events.buy_open, { count: 1, visitors: 1 });
    assert.equal(res.headers["cache-control"], "no-store");
  });
});
