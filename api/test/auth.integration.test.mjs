import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.SES_SMTP_HOST = "email-smtp.test.invalid";
process.env.SES_SMTP_PORT = "465";
process.env.SES_SMTP_USER = "test-user";
process.env.SES_SMTP_PASSWORD = "test-pass";
process.env.MAIL_FROM_NAME = "220v Test";
process.env.MAIL_FROM_EMAIL = "test@example.invalid";
process.env.RMW_API_URL = "https://rmw.test";
process.env.RMW_API_KEY = "test-key";

const { app } = await import("../index.mjs");
const { redis } = await import("../redis.mjs");
const { hashCode } = await import("../auth/crypto.mjs");
const { saveSession } = await import("../auth/session.mjs");
const { otpCooldownKey, otpKey, refUserStatusKey } = await import("../auth/keys.mjs");
const { acquireOtpCooldown, clearOtpAndCooldown, putOtp } = await import("../auth/otp.mjs");
const { queryReferralEvents } = await import("../referrals/events.mjs");
const originalFetch = globalThis.fetch;

async function withTestServer(fn) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.on("error", reject);
  });
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function requestJson(method, path, body, headers = {}) {
  return withTestServer(async (baseUrl) => {
    const res = await originalFetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsedBody = {};
    try {
      parsedBody = text ? JSON.parse(text) : {};
    } catch {
      parsedBody = { text };
    }
    return {
      status: res.status,
      body: parsedBody,
      headers: res.headers,
    };
  });
}

async function requestJsonWithSession(method, path, body, sessionData = {}) {
  const sid = `sid-${Math.random().toString(16).slice(2)}`;
  const csrf = `csrf-${Math.random().toString(16).slice(2)}`;
  await saveSession(sid, {
    userUuid: "b6810e6c-8a69-42b1-b298-8b07d8378987",
    email: "promo-user@example.com",
    csrf,
    expAt: Date.now() + 600_000,
    ...sessionData,
  });
  return requestJson(method, path, body, {
    Cookie: `v220_sid=${sid}; v220_csrf=${csrf}`,
    "X-CSRF-Token": csrf,
  });
}

describe("auth integration", () => {
  before(async () => {
    await redis.flushdb();
  });

  beforeEach(async () => {
    await redis.flushdb();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    await redis.quit();
  });

  it("GET /api/me without cookie returns 401", async () => {
    const res = await requestJson("GET", "/api/me");
    assert.equal(res.status, 401);
  });

  it("GET /api/health returns ok", async () => {
    const res = await requestJson("GET", "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it("verify invalid code increments tries", async () => {
    const email = "user@example.com";
    const code = "12345";
    await redis.set(
      otpKey(email),
      JSON.stringify({ hash: hashCode(code), tries: 0, owner: "test-owner" }),
      "EX",
      600,
    );

    const res = await requestJson("POST", "/api/auth/verify", { email, code: "00000" });

    assert.equal(res.status, 400);
  });

  it("allows only one active OTP cooldown per email", async () => {
    const email = "cooldown@example.com";

    const first = await acquireOtpCooldown(email, "owner-a", 60);
    const second = await acquireOtpCooldown(email, "owner-b", 60);

    assert.equal(first, "OK");
    assert.notEqual(second, "OK");
    assert.equal(await redis.get(otpCooldownKey(email)), "owner-a");
  });

  it("does not let old cleanup delete a newer owned OTP", async () => {
    const email = "cleanup@example.com";

    await putOtp(email, hashCode("11111"), "owner-old");
    await redis.set(otpCooldownKey(email), "owner-old", "EX", 60);
    await putOtp(email, hashCode("22222"), "owner-new");
    await redis.set(otpCooldownKey(email), "owner-new", "EX", 60);

    await clearOtpAndCooldown(email, "owner-old");

    const rawOtp = await redis.get(otpKey(email));
    const otp = JSON.parse(rawOtp);
    assert.equal(otp.owner, "owner-new");
    assert.equal(await redis.get(otpCooldownKey(email)), "owner-new");
  });

  it("keeps a correct OTP retryable when profile load fails", async () => {
    const email = "retry@example.com";
    const code = "12345";
    const userUuid = "b6810e6c-8a69-42b1-b298-8b07d8378987";
    await putOtp(email, hashCode(code), "test-owner");

    let sessionAttempts = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.endsWith("/v1/auth/session")) {
        sessionAttempts += 1;
        if (sessionAttempts === 1) {
          const err = new Error("profile timed out");
          err.isTimeout = true;
          err.timeoutMs = 8000;
          throw err;
        }
        return Response.json({
          exists: true,
          user: {
            userUuid,
            plan: "Premium",
            tariff: "1month",
          },
        });
      }
      if (href.includes("/v1/hwid/devices/")) {
        return Response.json({ devices: [], total: 0 });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    };

    const first = await requestJson("POST", "/api/auth/verify", { email, code });

    assert.equal(first.status, 504);
    assert.ok(await redis.get(otpKey(email)));

    const second = await requestJson("POST", "/api/auth/verify", { email, code });

    assert.equal(second.status, 200);
    assert.equal(second.body.user.userUuid, userUuid);
    assert.equal(await redis.get(otpKey(email)), null);
  });

  it("does not pass blocked referrer UUID to RMW auth session", async () => {
    const email = "blocked-ref@example.com";
    const code = "12345";
    const referrerUuid = "11111111-1111-1111-8111-111111111111";
    const userUuid = "b6810e6c-8a69-42b1-b298-8b07d8378987";
    await putOtp(email, hashCode(code), "test-owner");
    await redis.hset(refUserStatusKey(referrerUuid), {
      penalized: "1",
      pointsBlocked: "1",
      penalizedAt: new Date().toISOString(),
      pointsBlockedAt: new Date().toISOString(),
    });

    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href.endsWith("/v1/auth/session")) {
        assert.equal(JSON.parse(options.body).ref_uuid, undefined);
        return Response.json({
          exists: true,
          user: {
            userUuid,
            plan: "Premium",
            tariff: "1month",
          },
        });
      }
      if (href.includes("/v1/hwid/devices/")) {
        return Response.json({ devices: [], total: 0 });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    };

    const res = await requestJson("POST", "/api/auth/verify", { email, code, ref_uuid: referrerUuid });

    assert.equal(res.status, 200);
    const events = await queryReferralEvents({ referrerUuid, limit: 10 });
    assert.equal(events[0].type, "ref_credit_skipped");
    assert.equal(events[0].reason, "referrer_points_blocked");
  });

  it("DELETE /api/me/devices/x without session returns 401", async () => {
    const res = await requestJson("DELETE", "/api/me/devices/hwid-1");
    assert.equal(res.status, 401);
  });

  it("POST /api/me/promo-code/apply without session returns 401", async () => {
    const res = await requestJson("POST", "/api/me/promo-code/apply", { promo_code: "FREE7DAYS" });
    assert.equal(res.status, 401);
  });

  it("POST /api/me/promo-code/apply rejects invalid promo code", async () => {
    const res = await requestJsonWithSession("POST", "/api/me/promo-code/apply", { promo_code: "bad code!" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Проверьте промокод/);
  });

  it("POST /api/me/promo-code/apply proxies the session user UUID to RMW", async () => {
    const userUuid = "b6810e6c-8a69-42b1-b298-8b07d8378987";
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href.endsWith("/v1/billing/promo-code/apply")) {
        assert.equal(options.headers["X-Api-Key"], "test-key");
        assert.deepEqual(JSON.parse(options.body), {
          user_ref: userUuid,
          promo_code: "FREE7DAYS",
        });
        return Response.json({
          ok: true,
          user_id: 123,
          promo_code: "FREE7DAYS",
          days_added: 7,
          prev_expire_at: "2026-06-23T00:00:00Z",
          new_expire_at: "2026-06-30T00:00:00Z",
        });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    };

    const res = await requestJsonWithSession("POST", "/api/me/promo-code/apply", {
      promo_code: "free7days",
    }, { userUuid });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.promo_code, "FREE7DAYS");
    assert.equal(res.body.days_added, 7);
  });

  it("POST /api/me/promo-code/apply hides RMW failure details", async () => {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.endsWith("/v1/billing/promo-code/apply")) {
        return Response.json({ error: "promo code already used by this user" }, { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    };

    const res = await requestJsonWithSession("POST", "/api/me/promo-code/apply", {
      promo_code: "FREE7DAYS",
    });

    assert.equal(res.status, 502);
    assert.equal(res.body.error, "Промокод недействителен, уже использован или временно недоступен");
  });
});
