import { describe, it, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.LOG_LEVEL = "silent";
process.env.RMW_API_URL = "https://rmw.test";
process.env.RMW_API_KEY = "test-key";
process.env.BILLING_ALLOWED_HOSTS = "pay.test";
process.env.BILLING_SUCCESS_URL = "https://site.test/pay/success";
process.env.BILLING_CANCEL_URL = "https://site.test/pay/fail";
const { app } = await import("../index.mjs");
const { redis } = await import("../redis.mjs");
const { saveSession, getSession, updateSessionPromo } = await import("../auth/session.mjs");
const { normalizePromo, processPromo, releasePromoLock, resultKey, lockKey } = await import("../promo.mjs");
const { SESSION_COOKIE, CSRF_COOKIE, PROMO_PENDING_COOKIE } = await import("../config.mjs");
const { sessionKey } = await import("../auth/keys.mjs");
const originalFetch = globalThis.fetch;
const originalPublicSite = process.env.PUBLIC_SITE_URL;
const userUuid = "b6810e6c-8a69-42b1-b298-8b07d8378987";
const sid = "promo-test";
let calls, applyResponse, checkoutResponse, statusResponse, profile, onCheckout;
const auth = (req, pending) => req.set("Cookie", `${SESSION_COOKIE}=${sid}; ${CSRF_COOKIE}=csrf${pending ? `; ${PROMO_PENDING_COOKIE}=${encodeURIComponent(JSON.stringify(pending))}` : ""}`).set("X-CSRF-Token", "csrf");
const resolve = (body, pending) => auth(request(app).post("/api/promo/resolve"), pending).send(body);
const sale = (code = "SALE") => resolve({ kind: "sale", promo_code: code });
const checkout = (body = {}) => auth(request(app).post("/api/checkout")).send({ product_key: "sub_1m", payment_method: 2, ...body });
const current = async () => (await getSession(sid))?.activePromo;

describe("promo lifecycle with mocked billing", () => {
  before(() => Object.defineProperty(redis, "status", { configurable: true, value: "ready" }));
  beforeEach(async () => {
    await redis.flushall();
    await saveSession(sid, { userUuid, email: "test@example.com", csrf: "csrf", expAt: Date.now() + 86400000 });
    calls = [];
    applyResponse = () => Response.json({ days_added: 7, new_expire_at: "2026-12-31T00:00:00Z" });
    checkoutResponse = () => Response.json({ payment_url: "https://pay.test/order", transaction_id: "tx-1", payment_id: 1 });
    statusResponse = (body) => Response.json({
      id: 1, transaction_id: "tx-1", payment_url: "https://pay.test/order", tariff_key: body.tariff_key,
      payment_method_id: body.payment_method, promo_code: body.promo_code, original_amount: 80,
    });
    profile = { userUuid, tariff: "1month", plan: "1 Месяц", status: "ACTIVE", expireAt: new Date(Date.now() + 86400000).toISOString() };
    onCheckout = async () => {};
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href.endsWith("/v1/payments/list")) return Response.json([{ id: 2, type: "sbp" }, { id: 11, type: "card" }, { id: 13, type: "crypto", active: false }]);
      if (href.endsWith("/v1/payments/methods")) return Response.json({ items: [{ id: 2, type: "sbp", provider: " YooKassa ", is_active: true }, { id: 11, type: "card", provider: " TRIBUTE ", is_active: true }, { id: 13, type: "crypto", provider: "Other", is_active: false }] });
      if (href.endsWith("/v1/products/list")) return Response.json(["basic_1m", "traffic_20gb"].map((name) => ({ name, price: 100 })));
      if (href.endsWith("/v1/auth/session")) return Response.json({ exists: true, user: profile });
      if (href.includes("/v1/hwid/devices/")) return Response.json({ devices: [], total: 0 });
      if (href.endsWith("/v1/billing/promo-code/apply")) {
        calls.push({ url: href, headers: options.headers, body: JSON.parse(options.body) });
        await new Promise((r) => setTimeout(r, 30));
        return applyResponse();
      }
      if (href.endsWith("/v1/billing/checkout")) {
        calls.push({ url: href, headers: options.headers, body: JSON.parse(options.body) });
        await onCheckout();
        return checkoutResponse();
      }
      if (href.endsWith("/v1/billing/transactions/tx-1")) {
        return statusResponse(calls.at(-1)?.body ?? {});
      }
      throw new Error(`Unexpected fetch: ${href}`);
    };
  });
  afterEach(() => {
    if (originalPublicSite === undefined) delete process.env.PUBLIC_SITE_URL;
    else process.env.PUBLIC_SITE_URL = originalPublicSite;
  });
  after(async () => { globalThis.fetch = originalFetch; await redis.quit(); });

  it("normalizes API aliases without applying the manual-form restrictions", () => {
    assert.deepEqual(normalizePromo({ kind: " DAYS ", promo_code: 12, code: " a=b " }), { kind: "days", code: "A=B" });
    for (const value of [{ kind: "sale", code: " " }, { kind: "x", code: "A" }, { kind: "sale", code: "ß".repeat(33) }]) assert.equal(normalizePromo(value), null);
  });
  it("captures a guest code into a seven-day HttpOnly cookie and rejects cross-site requests", async () => {
    const res = await request(app).post("/api/promo/capture").set("Host", "site.test").set("Origin", "https://site.test").send({ kind: " Sale ", code: " spring20 " });
    assert.equal(res.status, 200);
    assert.match(res.headers["set-cookie"][0], /Max-Age=604800/);
    assert.match(res.headers["set-cookie"][0], /HttpOnly/);
    assert.match(res.headers["set-cookie"][0], /SameSite=Lax/);
    for (const [header, value] of [["Origin", "https://evil.test"], ["Origin", "invalid"], ["Sec-Fetch-Site", "cross-site"], ["Sec-Fetch-Site", "same-site"]]) {
      const denied = await request(app).post("/api/promo/capture").set(header, value).send({ kind: "sale", code: "A" });
      assert.equal(denied.status, 403);
    }
    assert.equal((await request(app).post("/api/promo/capture").send({ kind: "sale", code: "" })).body.code, "invalid_promo");
  });
  it("accepts the configured public origin when the reverse proxy rewrites Host", async () => {
    process.env.PUBLIC_SITE_URL = "https://220v.shop/";
    const res = await request(app).post("/api/promo/capture")
      .set("Host", "upstream.220v.internal").set("Origin", "https://220v.shop")
      .set("Sec-Fetch-Site", "same-origin").send({ kind: "days", code: "TEST228" });
    assert.equal(res.status, 200);
    assert.match(res.headers["set-cookie"][0], /v220_promo_pending=/);
    assert.equal(calls.length, 0);
  });
  it("requires the exact configured origin and still rejects cross-site captures", async () => {
    process.env.PUBLIC_SITE_URL = "https://220v.shop";
    for (const origin of ["https://evil.test", "http://220v.shop", "https://220v.shop:9443", "https://220v.shop.evil.test", "https://220v.shop@evil.test", "https://220v.shop/path", "null"]) {
      const res = await request(app).post("/api/promo/capture")
        .set("Host", "upstream.220v.internal").set("Origin", origin)
        .set("Sec-Fetch-Site", "same-origin").send({ kind: "days", code: "A" });
      assert.equal(res.status, 403, origin);
    }
    const res = await request(app).post("/api/promo/capture")
      .set("Host", "upstream.220v.internal").set("Origin", "https://220v.shop")
      .set("Sec-Fetch-Site", "cross-site").send({ kind: "days", code: "A" });
    assert.equal(res.status, 403);
  });
  it("does not trust forwarded hosts or invalid public-site configuration", async () => {
    for (const configured of ["", "invalid", "javascript:alert(1)", "https://user:password@220v.shop"]) {
      process.env.PUBLIC_SITE_URL = configured;
      const res = await request(app).post("/api/promo/capture")
        .set("Host", "upstream.220v.internal").set("Origin", "https://220v.shop")
        .set("X-Forwarded-Host", "220v.shop").set("Forwarded", "host=220v.shop;proto=https")
        .send({ kind: "days", code: "A" });
      assert.equal(res.status, 403);
    }
  });
  it("preserves direct local capture with a port even when a public site is configured", async () => {
    process.env.PUBLIC_SITE_URL = "https://220v.shop";
    const res = await request(app).post("/api/promo/capture")
      .set("Host", "localhost:9080").set("Origin", "http://localhost:9080")
      .send({ kind: "sale", code: "A" });
    assert.equal(res.status, 200);
  });
  it("rate limits public captures by IP", async () => {
    for (let i = 0; i < 120; i += 1) {
      assert.equal((await request(app).post("/api/promo/capture").set("X-Forwarded-For", "192.0.2.42").send({ kind: "sale", code: "A" })).status, 200);
    }
    const blocked = await request(app).post("/api/promo/capture").set("X-Forwarded-For", "192.0.2.42").send({ kind: "sale", code: "A" });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /^Слишком много переходов по промоссылкам\. Повторите через /);
  });
  it("keeps pending for a guest and requires CSRF for authenticated resolve", async () => {
    const res = await request(app).post("/api/promo/resolve").set("Cookie", `${PROMO_PENDING_COOKIE}=anything`);
    assert.equal(res.status, 401);
    assert.equal(res.headers["set-cookie"], undefined);
    assert.equal((await request(app).post("/api/promo/resolve").set("Cookie", `${SESSION_COOKIE}=${sid}`).send({ kind: "sale", code: "A" })).status, 403);
  });
  it("resolves pending after login, replaces sale, exposes only public active state", async () => {
    assert.equal((await resolve({}, { kind: "sale", code: " first " })).body.status, "pending_checkout_validation");
    const second = await sale("second");
    assert.equal(second.body.promo.code, "SECOND");
    assert.ok(second.body.promo.activated_at);
    const active = await auth(request(app).get("/api/promo/active"));
    assert.deepEqual(active.body, { active: true, promo: second.body.promo });
    assert.equal(calls.length, 0);
  });
  it("prefers explicit input, never falls back from invalid input, discards malformed cookie", async () => {
    await resolve({ kind: "sale", code: "BODY" }, { kind: "sale", code: "COOKIE" });
    assert.equal((await current()).code, "BODY");
    assert.equal((await resolve({ code: "broken" }, { kind: "sale", code: "COOKIE" })).status, 400);
    const none = await resolve({}, { kind: "bad", code: "X" });
    assert.equal(none.body.status, "none");
    assert.match(none.headers["set-cookie"][0], /Expires=Thu, 01 Jan 1970/);
    assert.equal((await current()).code, "BODY");
  });
  it("deduplicates concurrent days and does not replay mutations from cached responses", async () => {
    await sale();
    const body = { kind: "days", promo_code: "FREE" };
    const [a, b] = await Promise.all([resolve(body), resolve(body)]);
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, b.body);
    assert.equal(a.body.days_added, 7);
    assert.equal(await current(), undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { user_ref: userUuid, promo_code: "FREE" });
    assert.equal(calls[0].headers["X-Api-Key"], "test-key");
    await sale("NEW");
    assert.deepEqual((await resolve(body)).body, a.body);
    assert.equal((await current()).code, "NEW");
    assert.equal(calls.length, 1);
  });
  for (const [label, response, expected] of [
    ["billing rejection", () => Response.json({ error: "secret internal error" }, { status: 503 }), 400],
    ["timeout", () => { throw new Error("timeout"); }, 502],
    ["malformed success", () => new Response("bad JSON"), 502],
    ["false success", () => Response.json({ ok: false, days_added: 7 }), 502],
  ]) it(`caches ${label}, clears pending, preserves sale`, async () => {
    await sale();
    applyResponse = response;
    const body = { kind: "days", code: "BAD" };
    const res = await resolve(body);
    assert.equal(res.status, expected);
    assert.equal(res.body.error, "Промокод недействителен, уже использован или временно недоступен");
    assert.ok(res.headers["set-cookie"]);
    assert.equal((await current()).code, "SALE");
    assert.deepEqual((await resolve(body)).body, res.body);
    assert.equal(calls.length, 1);
  });
  it("returns 409 without clearing pending when the session lock is occupied", async () => {
    await redis.set(lockKey(sid), "owner", "EX", 20);
    const result = await processPromo(sid, { kind: "days", code: "A" }, () => { throw new Error("must not call"); }, { waitMs: 5, pollMs: 5 });
    assert.equal(result.httpStatus, 409);
    assert.equal(result.clearPending, false);
    await releasePromoLock(lockKey(sid), "other-owner");
    assert.equal(await redis.get(lockKey(sid)), "owner");
  });
  it("rechecks cached results immediately after acquiring the lock", async () => {
    const candidate = { kind: "days", code: "RACE" };
    const cached = { httpStatus: 200, clearPending: true, body: { ok: true, status: "days_applied", days_added: 7 } };
    const originalSet = redis.set;
    redis.set = async function (key, ...args) {
      if (key === lockKey(sid)) await originalSet.call(this, resultKey(sid, candidate), JSON.stringify(cached), "EX", 60);
      return originalSet.call(this, key, ...args);
    };
    try {
      assert.deepEqual(await processPromo(sid, candidate, () => { throw new Error("must not call billing"); }), cached);
      assert.equal(calls.length, 0);
    } finally { redis.set = originalSet; }
  });
  it("retries atomic session updates without losing concurrent unrelated changes", async () => {
    const originalEval = redis.eval;
    let injected = false;
    redis.eval = async function (script, count, key, ...args) {
      if (!injected && key === sessionKey(sid)) {
        injected = true;
        const session = JSON.parse(await redis.get(key));
        await redis.set(key, JSON.stringify({ ...session, unrelated: "preserved" }), "EX", 120);
      }
      return originalEval.call(this, script, count, key, ...args);
    };
    try {
      await updateSessionPromo(sid, { kind: "sale", code: "A", version: "a" });
      assert.equal((await getSession(sid)).unrelated, "preserved");
      assert.equal((await current()).code, "A");
    } finally { redis.eval = originalEval; }
  });
  it("preserves TTL and unrelated fields and never resurrects a logged-out session", async () => {
    await redis.expire(sessionKey(sid), 120);
    await updateSessionPromo(sid, { kind: "sale", code: "A", version: "v1" });
    const ttl = await redis.ttl(sessionKey(sid));
    assert.ok(ttl > 0 && ttl <= 120);
    assert.equal((await getSession(sid)).email, "test@example.com");
    await redis.del(sessionKey(sid));
    assert.equal(await updateSessionPromo(sid, { kind: "sale", code: "B" }), 0);
    assert.equal(await getSession(sid), null);
  });
  it("clears all promo state on logout and expired sessions", async () => {
    await sale();
    const logout = await auth(request(app).post("/api/auth/logout"));
    assert.equal(logout.status, 200);
    assert.ok(logout.headers["set-cookie"].some((c) => c.startsWith(`${PROMO_PENDING_COOKIE}=`)));
    assert.equal(await getSession(sid), null);
    await saveSession(sid, { userUuid, email: "test@example.com", csrf: "csrf", expAt: 1 });
    const expired = await resolve({}, { kind: "sale", code: "A" });
    assert.equal(expired.status, 401);
    assert.ok(expired.headers["set-cookie"].some((c) => c.startsWith(`${PROMO_PENDING_COOKIE}=`)));
  });
  it("uses only session identity/code at checkout and consumes before actual payment", async () => {
    await sale("SAVED");
    assert.equal((await checkout({ expected_promo_code: "SAVED", promo_code: "INJECTED", user_ref: "attacker", price: 1 })).status, 200);
    assert.equal(calls[0].body.promo_code, "SAVED");
    assert.equal(calls[0].body.user_ref, userUuid);
    assert.equal(calls[0].body.price, undefined);
    assert.equal(await current(), undefined);
    await checkout({ promo_code: "INJECTED" });
    assert.equal("promo_code" in calls[1].body, false);
  });
  it("does not create a full-price payment when the browser expects a missing or different saved code", async () => {
    assert.equal((await checkout({ expected_promo_code: "TEST2289" })).body.code, "promo_not_saved");
    assert.equal(calls.length, 0);
    await sale("OTHER");
    assert.equal((await checkout({ expected_promo_code: "TEST2289" })).body.code, "promo_not_saved");
    assert.equal(calls.length, 0);
    assert.equal((await current()).code, "OTHER");
  });
  it("accepts and consumes a session promo without an internal version", async () => {
    await updateSessionPromo(sid, { kind: "sale", code: "LEGACY", activatedAt: new Date().toISOString() });
    assert.equal((await checkout()).status, 200);
    assert.equal(calls[0].body.promo_code, "LEGACY");
    assert.equal(await current(), undefined);
  });
  it("blocks tribute with promo, allows without promo and excludes inactive methods", async () => {
    await sale();
    const meta = await request(app).get("/api/billing/meta");
    assert.equal(meta.body.payments.find((method) => method.id === 11)?.provider, "tribute");
    assert.equal((await checkout({ payment_method: 11 })).body.code, "promo_provider_unsupported");
    assert.equal(calls.length, 0);
    assert.equal((await current()).code, "SALE");
    assert.equal((await checkout({ payment_method: 13 })).status, 400);
    await updateSessionPromo(sid, null);
    assert.equal((await checkout({ payment_method: 11 })).status, 200);
  });
  it("stops a payment redirect when RMW silently omits the promo or keeps the original amount", async () => {
    await sale("TEST2289");
    for (const payment of [
      { promo_code: null, original_amount: 80 },
      { promo_code: "TEST2289", original_amount: 100 },
    ]) {
      statusResponse = (body) => Response.json({
        id: 1, transaction_id: "tx-1", payment_url: "https://pay.test/order", tariff_key: body.tariff_key,
        payment_method_id: body.payment_method, ...payment,
      });
      const response = await checkout();
      assert.equal(response.status, 409);
      assert.equal(response.body.code, "promo_unverified");
      assert.equal(response.body.payment_url, undefined);
      assert.equal((await current()).code, "TEST2289");
    }
  });
  for (const [error, code, keep] of [
    ["promo code is invalid or unavailable", "promo_code_invalid", false],
    ["unsupported promo discount type", "promo_code_invalid", false],
    ["payment amount must be greater than zero", "promo_not_applicable", true],
    ["other failure", undefined, true],
  ]) it(`handles checkout error ${error}`, async () => {
    await sale();
    checkoutResponse = () => Response.json({ error }, { status: 400 });
    const res = await checkout();
    assert.equal(res.status, 400);
    assert.equal(res.body.code, code);
    assert.equal(Boolean(await current()), keep);
    assert.equal(calls.length, 1);
  });
  it("preserves a newly saved version even when an older checkout succeeds or rejects it", async () => {
    for (const reject of [false, true]) {
      await sale("SAME");
      const version = (await current()).version;
      onCheckout = async () => { await sale("SAME"); };
      checkoutResponse = () => reject ? Response.json({ error: "promo code is invalid or unavailable" }, { status: 400 }) : Response.json({ payment_url: "https://pay.test/order" });
      await checkout();
      assert.equal((await current()).code, "SAME");
      assert.notEqual((await current()).version, version);
    }
  });
  it("keeps promo for invalid checkout JSON or unusable payment URL", async () => {
    await sale();
    for (const response of [() => new Response("bad"), () => Response.json({}), () => Response.json({ payment_url: "garbage" }), () => Response.json({ payment_url: "http://pay.test/order" }), () => Response.json({ payment_url: "https://evil.test/order" })]) {
      checkoutResponse = response;
      assert.equal((await checkout()).status, 502);
      assert.equal((await current()).code, "SALE");
    }
  });
  it("retains promo on traffic refusal and forwards it for allowed traffic purchases", async () => {
    await sale();
    profile.tariff = "trial";
    assert.equal((await checkout({ product_key: "traffic_20gb" })).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await current()).code, "SALE");
    profile.tariff = "1month";
    assert.equal((await checkout({ product_key: "traffic_20gb" })).status, 200);
    assert.equal(calls[0].body.promo_code, "SALE");
  });
  it("shares the RMW call with the manual days form", async () => {
    const res = await auth(request(app).post("/api/me/promo-code/apply")).send({ promo_code: "free7days" });
    assert.equal(res.status, 200);
    assert.equal(res.body.days_added, 7);
    assert.deepEqual(calls[0].body, { user_ref: userUuid, promo_code: "FREE7DAYS" });
  });
});
