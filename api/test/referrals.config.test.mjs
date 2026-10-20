import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.RMW_API_URL = "https://rmw.test";
process.env.RMW_API_KEY = "test-key";

const { app } = await import("../index.mjs");
const { redis } = await import("../redis.mjs");
const { saveSession } = await import("../auth/session.mjs");
const { SESSION_COOKIE, CSRF_COOKIE } = await import("../config.mjs");
const { refUserStatusKey } = await import("../auth/keys.mjs");

const uuid = "5b5f1c0e-1d2a-4c3b-9a8e-7f6d5c4b3a21";
const originalFetch = globalThis.fetch;

let pointsCalls;
let eligibility;
let pointsStatus;

function getConfig({ cookie = true } = {}) {
  const req = request(app).get("/api/me/referrals/config");
  if (cookie) req.set("Cookie", [`${SESSION_COOKIE}=ref-config-test`, `${CSRF_COOKIE}=test-csrf`]);
  return req;
}

beforeEach(async () => {
  await redis.flushdb();
  await saveSession("ref-config-test", { userUuid: uuid, email: "config@example.com", csrf: "test-csrf" });
  pointsCalls = 0;
  eligibility = { active: true, reason: null };
  pointsStatus = 200;
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(url);
    if (pathname === `/v1/users/${uuid}/referral-points`) {
      pointsCalls += 1;
      const body = pointsStatus === 200 ? { balance: 0, items: [], eligibility } : { error: "down" };
      return new Response(JSON.stringify(body), { status: pointsStatus });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
after(async () => {
  await redis.quit();
});

describe("GET /api/me/referrals/config", () => {
  it("requires a session", async () => {
    const res = await getConfig({ cookie: false });
    assert.equal(res.status, 401);
  });

  it("returns the referral rules and availability", async () => {
    const res = await getConfig();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      pointsPerDay: 10,
      registrationPoints: 1,
      firstPaymentPoints: { "1m": 100, "6m": 600, "12m": 1200 },
      repeatPaymentPercent: 10,
      available: true,
      eligible: true,
    });
  });

  it("passes through an inactive eligibility from RMW", async () => {
    eligibility = { active: false, reason: "no_paid_tariff" };
    const res = await getConfig();
    assert.equal(res.body.available, true);
    assert.equal(res.body.eligible, false);
  });

  it("keeps the config usable when RMW is down", async () => {
    pointsStatus = 503;
    const res = await getConfig();
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
    assert.equal(res.body.eligible, null);
    assert.equal(res.body.pointsPerDay, 10);
  });

  it("marks the program unavailable when accrual is blocked and skips RMW", async () => {
    await redis.hset(refUserStatusKey(uuid), { pointsBlocked: "1" });
    const res = await getConfig();
    assert.equal(res.status, 200);
    assert.equal(res.body.available, false);
    assert.equal(res.body.eligible, null);
    assert.equal(pointsCalls, 0);
  });
});
