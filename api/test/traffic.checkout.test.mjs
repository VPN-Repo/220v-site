import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { trafficPurchaseRestriction, TRAFFIC_MIN_REMAINING_MS } from "../billing/trafficEligibility.mjs";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.RMW_API_URL = "https://rmw.test";
process.env.RMW_API_KEY = "test-key";
process.env.BILLING_ALLOWED_HOSTS = "pay.test";

const { app } = await import("../index.mjs");
const { redis } = await import("../redis.mjs");
const { saveSession } = await import("../auth/session.mjs");
const { SESSION_COOKIE, CSRF_COOKIE } = await import("../config.mjs");
const uuid = "b6810e6c-8a69-42b1-b298-8b07d8378987";
const originalFetch = globalThis.fetch;
let profile;
let checkoutCalls;
let profileUnavailable;

function checkout(product_key = "traffic_20gb", payment_method = 2) {
  return request(app).post("/api/checkout")
    .set("Cookie", [`${SESSION_COOKIE}=traffic-test`, `${CSRF_COOKIE}=test-csrf`])
    .set("X-CSRF-Token", "test-csrf")
    .send({ product_key, payment_method });
}

beforeEach(async () => {
  await redis.flushdb();
  await saveSession("traffic-test", { userUuid: uuid, email: "traffic@example.com", csrf: "test-csrf" });
  profile = { userUuid: uuid, tariff: "1month", plan: "1 Месяц", expireAt: new Date(Date.now() + 7 * 3600_000).toISOString() };
  checkoutCalls = [];
  profileUnavailable = false;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (path === "/v1/payments/list") return json([2, 11, 13].map(id => ({ id, type: "card" })));
    if (path === "/v1/products/list") return json(["traffic_20gb", "traffic_50gb", "basic_1m"].map(name => ({ name, price: 150 })));
    if (path === "/v1/auth/session") return profileUnavailable ? json({}, 503) : json({ exists: true, user: profile });
    if (path.startsWith("/v1/hwid/devices/")) return json({ devices: [], total: 0 });
    if (path === "/v1/billing/checkout") {
      checkoutCalls.push(JSON.parse(options.body));
      return json({ payment_url: "https://pay.test/payment" });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });
after(async () => { await redis.quit(); });

describe("traffic eligibility boundary", () => {
  it("allows exactly 6 hours but rejects one millisecond less", () => {
    const now = Date.now();
    const user = { tariff: "1month", expireAt: new Date(now + TRAFFIC_MIN_REMAINING_MS).toISOString() };
    assert.equal(trafficPurchaseRestriction(user, now), null);
    assert.match(trafficPurchaseRestriction(user, now + 1), /меньше 6 часов/);
  });

  it("rejects trial independently of expiry and prefers tariff over legacy plan labels", () => {
    assert.match(trafficPurchaseRestriction({ ...profile, tariff: " TRIAL ", plan: "Premium" }), /тестовом/);
    assert.match(trafficPurchaseRestriction({ ...profile, tariff: undefined, plan: "Test" }), /тестовом/);
    assert.equal(trafficPurchaseRestriction({ ...profile, plan: "Test" }), null);
  });
});

describe("traffic checkout enforcement", () => {
  for (const product of ["traffic_20gb", "traffic_50gb"]) {
    for (const method of [2, 11, 13]) {
      it(`blocks trial for ${product}, payment ${method}`, async () => {
        profile.tariff = "trial";
        const response = await checkout(product, method);
        assert.equal(response.status, 403);
        assert.match(response.body.error, /тестовом/);
        assert.equal(checkoutCalls.length, 0);
      });
    }
  }

  for (const remaining of [6 * 3600_000 - 1, 0, -3600_000]) {
    it(`blocks a paid tariff with ${remaining}ms remaining`, async () => {
      profile.expireAt = new Date(Date.now() + remaining).toISOString();
      const response = await checkout();
      assert.equal(response.status, 403);
      assert.match(response.body.error, /меньше 6 часов/);
      assert.equal(checkoutCalls.length, 0);
    });
  }

  it("allows paid traffic then uses fresh profile data on the next attempt", async () => {
    assert.equal((await checkout("traffic_50gb", 13)).status, 200);
    assert.equal(checkoutCalls[0].tariff_key, "traffic_50gb");
    profile.expireAt = new Date(Date.now() + 3600_000).toISOString();
    assert.equal((await checkout()).status, 403);
    assert.equal(checkoutCalls.length, 1);
  });

  it("allows subscription purchases for trial users", async () => {
    profile.tariff = "trial";
    assert.equal((await checkout("sub_1m")).status, 200);
    assert.equal(checkoutCalls.length, 1);
  });

  it("does not create a payment if the profile cannot be verified", async () => {
    profileUnavailable = true;
    assert.equal((await checkout()).status, 502);
    assert.equal(checkoutCalls.length, 0);
  });

  it("rejects a profile belonging to a different user", async () => {
    profile.userUuid = "a6810e6c-8a69-42b1-b298-8b07d8378987";
    assert.equal((await checkout()).status, 502);
    assert.equal(checkoutCalls.length, 0);
  });

  for (const expireAt of [undefined, "invalid"]) {
    it(`rejects an unverifiable expiry: ${expireAt}`, async () => {
      profile.expireAt = expireAt;
      assert.equal((await checkout()).status, 403);
      assert.equal(checkoutCalls.length, 0);
    });
  }
});
