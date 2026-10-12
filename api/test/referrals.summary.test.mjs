import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.ADMIN_REDIS_TOKEN = "admin-test-token";
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
const { saveSession } = await import("../auth/session.mjs");
const { base64url, emailHash } = await import("../auth/crypto.mjs");
const { SESSION_COOKIE, CSRF_COOKIE } = await import("../config.mjs");
const { refEventsListKey, refExchangeRequestKey, refUserStatusKey } = await import("../auth/keys.mjs");
const { recordReferralEvent } = await import("../referrals/events.mjs");
const originalFetch = globalThis.fetch;

const REF_A = "11111111-1111-1111-8111-111111111111";
const REF_B = "22222222-2222-2222-8222-222222222222";
const REF_C = "33333333-3333-3333-8333-333333333333";
const REF_D = "44444444-4444-4444-8444-444444444444";

async function createSessionAgent(userUuid = REF_A) {
  const sid = base64url(randomBytes(32));
  const csrf = base64url(randomBytes(32));
  await saveSession(sid, {
    userUuid,
    email: "referrer@example.com",
    csrf,
    expAt: Date.now() + 3600_000,
  });

  const agent = request.agent(app);
  agent.set("Cookie", [`${SESSION_COOKIE}=${sid}`, `${CSRF_COOKIE}=${csrf}`]);
  agent.set("X-CSRF-Token", csrf);
  return agent;
}

function event(overrides) {
  return {
    id: `evt-${Math.random().toString(16).slice(2)}`,
    type: "ref_click",
    at: new Date().toISOString(),
    referrerUuid: REF_A,
    ipHash: "ip-a",
    uaHash: "ua-a",
    fingerprintHash: "fp-a",
    selfReferral: false,
    path: "/api/test",
    refererUrl: "",
    ...overrides,
  };
}

async function seedEvents(events) {
  if (events.length === 0) return;
  await redis.lpush(refEventsListKey(), ...events.map((item) => JSON.stringify(item)));
}

function fakeReferralReq(ip) {
  return {
    ip,
    path: "/api/test",
    socket: { remoteAddress: ip },
    get(name) {
      if (name === "User-Agent") return `test-agent-${ip}`;
      return "";
    },
    log: { warn() {} },
  };
}

function getSummary(query = "") {
  return request(app)
    .get(`/api/admin/referrals/summary${query}`)
    .set("X-Admin-Token", "admin-test-token");
}

function mockReferralPointsFetch({ balance = 100, items = [] } = {}) {
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/v1\/users\/.+\/referral-points\?page=1&limit=1$/);
    assert.equal(options.headers["X-Api-Key"], process.env.RMW_API_KEY);
    return new Response(
      JSON.stringify({
        balance,
        items,
        page: 1,
        limit: 1,
        total: items.length,
        total_pages: items.length > 0 ? 1 : 0,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

function blockReferralPoints(uuid) {
  return request(app)
    .post(`/api/admin/referrals/users/${uuid}/points/debit`)
    .set("X-Admin-Token", "admin-test-token")
    .send({ pointsBlocked: true });
}

function grantExchangePermission(uuid, { comment = "согласовано с поддержкой", expiresAt } = {}) {
  return request(app)
    .post(`/api/admin/referrals/users/${uuid}/exchange-permission`)
    .set("X-Admin-Token", "admin-test-token")
    .send({ comment, expiresAt: expiresAt ?? new Date(Date.now() + 3600_000).toISOString() });
}

function revokeExchangePermission(uuid) {
  return request(app)
    .post(`/api/admin/referrals/users/${uuid}/exchange-permission/revoke`)
    .set("X-Admin-Token", "admin-test-token");
}

// Two registrations sharing an IP (and therefore the fake request's User-Agent)
// score as a high-risk duplicate-signal match.
async function seedHighRiskRegistrations(uuid) {
  for (let idx = 0; idx < 2; idx += 1) {
    await recordReferralEvent("ref_verify_ok", fakeReferralReq("127.0.0.1"), {
      referrerUuid: uuid,
      referredEmailHash: `email-${idx}`,
      referredUuidPrefix: `user-${idx}`,
    });
  }
}

describe("referral admin summary", () => {
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

  it("requires admin token", async () => {
    const res = await request(app).get("/api/admin/referrals/summary");
    assert.equal(res.status, 401);
  });

  it("returns totals, funnel, and sorted risky referrers", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await seedEvents([
      event({ type: "ref_click", referrerUuid: REF_A }),
      event({ type: "ref_send_code", referrerUuid: REF_A, referredEmailHash: "email-a" }),
      event({ type: "ref_verify_ok", referrerUuid: REF_A, referredEmailHash: "email-a", referredUuidPrefix: "user-a" }),
      event({ type: "ref_self_referral", referrerUuid: REF_A, referredEmailHash: "email-a", referredUuidPrefix: "user-a", selfReferral: true }),
      event({ type: "ref_checkout_by_referred", referrerUuid: REF_B, referredUuidPrefix: "user-b", tariffKey: "basic_1m" }),
    ]);

    const res = await getSummary("?days=30&limit=50");

    assert.equal(res.status, 200);
    assert.equal(res.body.totals.events, 5);
    assert.equal(res.body.totals.referrers, 2);
    assert.equal(res.body.funnel.clicks, 1);
    assert.equal(res.body.funnel.codes, 1);
    assert.equal(res.body.funnel.verifies, 1);
    assert.equal(res.body.funnel.checkouts, 1);
    assert.equal(res.body.funnel.selfReferrals, 1);
    const refA = res.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    assert.ok(refA);
    // Self-referral is harmless (rejected by reward logic) and must not be flagged as fraud.
    assert.notEqual(refA.riskLevel, "critical");
    assert.ok(!refA.warnings.some((warning) => warning.code === "self_referral"));
    assert.equal(res.body.totals.multiAccountDetections, 0);
    assert.deepEqual(
      res.body.dailyRegistrations.find((item) => item.date === today),
      { date: today, registrations: 1, suspicious: 0 },
    );
  });

  it("does not flag a link open from another account without registration as critical", async () => {
    await seedEvents([
      event({ type: "ref_click", referrerUuid: REF_A, otherUserUuidPrefix: "99999999", selfReferral: false }),
      event({ type: "ref_self_referral", referrerUuid: REF_B, otherUserUuidPrefix: "22222222", selfReferral: true }),
    ]);

    const res = await getSummary("?days=all&limit=50");

    assert.equal(res.status, 200);
    assert.equal(res.body.totals.multiAccountDetections, 0);

    const refA = res.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    assert.ok(refA);
    assert.notEqual(refA.riskLevel, "critical");
    assert.ok(!refA.warnings.some((warning) => warning.code === "other_account_click_before_registration"));

    // A self-referral carries the user's own prefix and must not be treated as multi-account.
    const refB = res.body.referrers.find((referrer) => referrer.referrerUuid === REF_B);
    assert.ok(refB);
    assert.notEqual(refB.riskLevel, "critical");
    assert.ok(!refB.warnings.some((warning) => warning.code === "other_account_click_before_registration"));
  });

  it("flags registration after opening a referral link from another account in the same browser as critical", async () => {
    await seedEvents([
      event({
        type: "ref_click",
        at: "2026-01-01T00:00:00.000Z",
        referrerUuid: REF_A,
        otherUserUuidPrefix: "99999999",
        fingerprintHash: "fp-same-pc",
        ipHash: "ip-same-pc",
        uaHash: "ua-same-pc",
        selfReferral: false,
      }),
      event({
        type: "ref_verify_ok",
        at: "2026-01-01T00:01:00.000Z",
        referrerUuid: REF_A,
        referredEmailHash: "email-new",
        referredUuidPrefix: "new-user",
        fingerprintHash: "fp-same-pc",
        ipHash: "ip-same-pc",
        uaHash: "ua-same-pc",
      }),
    ]);

    const res = await getSummary("?days=all&limit=50");

    assert.equal(res.status, 200);
    assert.equal(res.body.totals.multiAccountDetections, 1);

    const refA = res.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    assert.ok(refA);
    assert.equal(refA.riskLevel, "critical");
    const warning = refA.warnings.find((item) => item.code === "other_account_click_before_registration");
    assert.ok(warning);
    assert.equal(warning.severity, "critical");
    assert.equal(warning.evidence.accounts, 1);
    assert.equal(warning.evidence.registrations, 1);
    assert.equal(warning.evidence.matches[0].referredEmailHash, "email-new");
  });

  it("marks repeated fingerprint identities as critical", async () => {
    await seedEvents([
      event({ type: "ref_send_code", referrerUuid: REF_B, fingerprintHash: "fp-shared", referredEmailHash: "email-1" }),
      event({ type: "ref_verify_ok", referrerUuid: REF_B, fingerprintHash: "fp-shared", referredUuidPrefix: "user-1" }),
      event({ type: "ref_send_code", referrerUuid: REF_B, fingerprintHash: "fp-shared", referredEmailHash: "email-2" }),
      event({ type: "ref_verify_ok", referrerUuid: REF_B, fingerprintHash: "fp-shared", referredUuidPrefix: "user-2" }),
    ]);

    const res = await getSummary("?days=all&limit=50");

    assert.equal(res.status, 200);
    assert.equal(res.body.referrers[0].riskLevel, "critical");
    assert.ok(
      res.body.referrers[0].warnings.some(
        (warning) => warning.code === "duplicate_registration_signals" && warning.severity === "critical",
      ),
    );
  });

  it("marks many verifies without checkout as medium", async () => {
    await seedEvents(
      Array.from({ length: 5 }, (_, index) =>
        event({
          type: "ref_verify_ok",
          referrerUuid: REF_C,
          ipHash: `ip-${index}`,
          fingerprintHash: `fp-${index}`,
          referredUuidPrefix: `user-${index}`,
        }),
      ),
    );

    const res = await getSummary("?days=all&limit=50");

    assert.equal(res.status, 200);
    assert.equal(res.body.referrers[0].riskLevel, "medium");
    const warning = res.body.referrers[0].warnings.find(
      (item) => item.code === "verifies_without_checkout",
    );
    assert.ok(warning);
    assert.equal(warning.severity, "medium");
  });

  it("explains repeated User-Agent activity without checkout", async () => {
    await seedEvents(
      Array.from({ length: 5 }, (_, index) =>
        event({
          type: "ref_click",
          referrerUuid: REF_A,
          ipHash: `ip-ua-${index}`,
          uaHash: "ua-repeat",
          fingerprintHash: `fp-ua-${index}`,
        }),
      ),
    );

    const res = await getSummary("?days=all&limit=50");
    assert.equal(res.status, 200);

    const warning = res.body.referrers[0].warnings.find(
      (item) => item.code === "repeated_user_agent_no_checkout",
    );

    assert.equal(res.body.referrers[0].riskLevel, "medium");
    assert.equal(res.body.referrers[0].riskScore, 30);
    assert.ok(warning);
    assert.equal(warning.label, "Много действий с одного браузера без оплат");
    assert.match(warning.description, /User-Agent hash/);
    assert.equal(warning.evidence.events, 5);
    assert.equal(warning.evidence.checkouts, 0);
  });

  it("explains repeated fingerprint activity without checkout", async () => {
    await seedEvents(
      Array.from({ length: 5 }, (_, index) =>
        event({
          type: "ref_click",
          referrerUuid: REF_A,
          ipHash: `ip-fp-${index}`,
          uaHash: `ua-fp-${index}`,
          fingerprintHash: "fp-repeat",
        }),
      ),
    );

    const res = await getSummary("?days=all&limit=50");
    assert.equal(res.status, 200);

    const warning = res.body.referrers[0].warnings.find(
      (item) => item.code === "repeated_fingerprint_no_checkout",
    );

    assert.equal(res.body.referrers[0].riskLevel, "medium");
    assert.equal(res.body.referrers[0].riskScore, 30);
    assert.ok(warning);
    assert.equal(warning.label, "Много действий с одного устройства без оплат");
    assert.match(warning.description, /fingerprint hash/);
    assert.equal(warning.evidence.events, 5);
    assert.equal(warning.evidence.checkouts, 0);
  });

  it("does not flag low click or code conversion as risk", async () => {
    await seedEvents([
      ...Array.from({ length: 20 }, (_, index) =>
        event({
          type: "ref_click",
          referrerUuid: REF_A,
          ipHash: `click-ip-${index}`,
          uaHash: `click-ua-${index}`,
          fingerprintHash: `click-fp-${index}`,
        }),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        event({
          type: "ref_send_code",
          referrerUuid: REF_B,
          ipHash: `code-ip-${index}`,
          uaHash: `code-ua-${index}`,
          fingerprintHash: `code-fp-${index}`,
          referredEmailHash: `email-${index}`,
        }),
      ),
    ]);

    const res = await getSummary("?days=all&limit=50");

    assert.equal(res.status, 200);
    const refA = res.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    const refB = res.body.referrers.find((referrer) => referrer.referrerUuid === REF_B);
    assert.equal(refA.riskLevel, "low");
    assert.equal(refB.riskLevel, "low");
    assert.ok(!refA.warnings.some((warning) => warning.code === "low_code_rate"));
    assert.ok(!refB.warnings.some((warning) => warning.code === "low_verify_rate"));
  });

  it("flags repeated auth IP only from four events", async () => {
    await seedEvents(
      Array.from({ length: 3 }, (_, index) =>
        event({
          type: "ref_send_code",
          referrerUuid: REF_A,
          ipHash: "ip-auth-repeat",
          uaHash: `ua-auth-${index}`,
          fingerprintHash: `fp-auth-${index}`,
          referredEmailHash: `email-${index}`,
        }),
      ),
    );

    const belowThreshold = await getSummary("?days=all&limit=50");

    assert.equal(belowThreshold.status, 200);
    assert.equal(belowThreshold.body.referrers[0].riskLevel, "low");
    assert.ok(
      !belowThreshold.body.referrers[0].warnings.some((warning) => warning.code === "repeated_auth_ip"),
    );

    await seedEvents([
      event({
        type: "ref_send_code",
        referrerUuid: REF_A,
        ipHash: "ip-auth-repeat",
        uaHash: "ua-auth-4",
        fingerprintHash: "fp-auth-4",
        referredEmailHash: "email-4",
      }),
    ]);

    const atThreshold = await getSummary("?days=all&limit=50");

    assert.equal(atThreshold.status, 200);
    assert.equal(atThreshold.body.referrers[0].riskLevel, "medium");
    const warning = atThreshold.body.referrers[0].warnings.find(
      (item) => item.code === "repeated_auth_ip",
    );
    assert.ok(warning);
    assert.equal(warning.severity, "medium");
  });

  it("keeps normal paid referral activity low risk", async () => {
    await seedEvents([
      event({ type: "ref_click", referrerUuid: REF_D, ipHash: "ip-1", fingerprintHash: "fp-1" }),
      event({ type: "ref_send_code", referrerUuid: REF_D, ipHash: "ip-1", fingerprintHash: "fp-1", referredEmailHash: "email-1" }),
      event({ type: "ref_verify_ok", referrerUuid: REF_D, ipHash: "ip-1", fingerprintHash: "fp-1", referredUuidPrefix: "user-1" }),
      event({ type: "ref_checkout_by_referred", referrerUuid: REF_D, ipHash: "ip-2", fingerprintHash: "fp-2", referredUuidPrefix: "user-1" }),
    ]);

    const res = await getSummary("?days=all&limit=50");

    assert.equal(res.status, 200);
    assert.equal(res.body.referrers[0].riskLevel, "low");
    assert.deepEqual(res.body.referrers[0].warnings, []);
  });

  it("marks two registrations sharing UA and FP as critical", async () => {
    await seedEvents([
      event({ type: "ref_verify_ok", referrerUuid: REF_A, uaHash: "ua-x", fingerprintHash: "fp-x", ipHash: "ip-1", referredUuidPrefix: "user-1", referredEmailHash: "email-1" }),
      event({ type: "ref_verify_ok", referrerUuid: REF_A, uaHash: "ua-x", fingerprintHash: "fp-x", ipHash: "ip-2", referredUuidPrefix: "user-2", referredEmailHash: "email-2" }),
    ]);

    const res = await getSummary("?days=all&limit=50");

    assert.equal(res.status, 200);
    const refA = res.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    assert.equal(refA.riskLevel, "critical");
    const warning = refA.warnings.find((item) => item.code === "duplicate_registration_signals");
    assert.ok(warning);
    assert.equal(warning.severity, "critical");
    assert.deepEqual(warning.evidence.matches[0].signals, { ua: true, fp: true, ip: false });
    assert.deepEqual(
      new Set([
        warning.evidence.matches[0].referredEmailHashA,
        warning.evidence.matches[0].referredEmailHashB,
      ]),
      new Set(["email-1", "email-2"]),
    );
  });

  it("marks two registrations sharing UA and IP as high", async () => {
    await seedEvents([
      event({ type: "ref_verify_ok", referrerUuid: REF_A, uaHash: "ua-x", fingerprintHash: "fp-1", ipHash: "ip-x", referredUuidPrefix: "user-1" }),
      event({ type: "ref_verify_ok", referrerUuid: REF_A, uaHash: "ua-x", fingerprintHash: "fp-2", ipHash: "ip-x", referredUuidPrefix: "user-2" }),
    ]);

    const res = await getSummary("?days=all&limit=50");

    assert.equal(res.status, 200);
    const refA = res.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    assert.equal(refA.riskLevel, "high");
    const warning = refA.warnings.find(
      (item) => item.code === "duplicate_registration_signals" && item.severity === "high",
    );
    assert.ok(warning);
    assert.deepEqual(warning.evidence.matches[0].signals, { ua: true, fp: false, ip: true });
  });

  it("marks two registrations sharing only UA as medium", async () => {
    await seedEvents([
      event({ type: "ref_verify_ok", referrerUuid: REF_A, uaHash: "ua-x", fingerprintHash: "fp-1", ipHash: "ip-1", referredUuidPrefix: "user-1" }),
      event({ type: "ref_verify_ok", referrerUuid: REF_A, uaHash: "ua-x", fingerprintHash: "fp-2", ipHash: "ip-2", referredUuidPrefix: "user-2" }),
    ]);

    const res = await getSummary("?days=all&limit=50");

    assert.equal(res.status, 200);
    const refA = res.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    assert.equal(refA.riskLevel, "medium");
    const warning = refA.warnings.find(
      (item) => item.code === "duplicate_registration_signals" && item.severity === "medium",
    );
    assert.ok(warning);
    assert.deepEqual(warning.evidence.matches[0].signals, { ua: true, fp: false, ip: false });
  });

  it("does not raise risk when only IP matches between registrations", async () => {
    await seedEvents([
      event({ type: "ref_verify_ok", referrerUuid: REF_A, uaHash: "ua-1", fingerprintHash: "fp-1", ipHash: "ip-x", referredUuidPrefix: "user-1" }),
      event({ type: "ref_verify_ok", referrerUuid: REF_A, uaHash: "ua-2", fingerprintHash: "fp-2", ipHash: "ip-x", referredUuidPrefix: "user-2" }),
    ]);

    const res = await getSummary("?days=all&limit=50");

    assert.equal(res.status, 200);
    const refA = res.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    assert.equal(refA.riskLevel, "low");
    assert.ok(!refA.warnings.some((item) => item.code === "duplicate_registration_signals"));
  });

  it("groups warnings by severity for the admin UI", async () => {
    await seedEvents([
      event({ type: "ref_verify_ok", referrerUuid: REF_A, uaHash: "ua-x", fingerprintHash: "fp-x", ipHash: "ip-1", referredUuidPrefix: "user-1" }),
      event({ type: "ref_verify_ok", referrerUuid: REF_A, uaHash: "ua-x", fingerprintHash: "fp-x", ipHash: "ip-2", referredUuidPrefix: "user-2" }),
    ]);

    const res = await getSummary("?days=all&limit=50");

    assert.equal(res.status, 200);
    const refA = res.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    assert.ok(refA.warningsBySeverity);
    assert.equal(refA.warningsBySeverity.critical.length, 1);
    assert.ok(Array.isArray(refA.warningsBySeverity.high));
    assert.ok(Array.isArray(refA.warningsBySeverity.medium));
  });

  it("validates period and caps limit without failing", async () => {
    const badPeriod = await getSummary("?days=soon");
    assert.equal(badPeriod.status, 400);

    await seedEvents([
      event({ type: "ref_click", referrerUuid: REF_A }),
      event({ type: "ref_click", referrerUuid: REF_B }),
    ]);

    const limited = await getSummary("?days=all&limit=1");
    assert.equal(limited.status, 200);
    assert.equal(limited.body.totals.events, 1);
  });

  it("returns a fresh referrer tariff and expiry from RMW by UUID", async () => {
    let lookupCount = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `${process.env.RMW_API_URL}/v1/users/${REF_A}`);
      assert.equal(options.headers["X-Api-Key"], process.env.RMW_API_KEY);
      lookupCount += 1;
      return new Response(
        JSON.stringify({
          uuid: REF_A,
          email: "referrer@example.com",
          tariff_key: lookupCount === 1 ? "premium_12m" : "basic_1m",
          tariff_state: lookupCount === 1 ? "active" : "expired",
          expire_at: lookupCount === 1 ? "2030-01-01T00:00:00Z" : "2020-01-01T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const res = await request(app)
      .get(`/api/admin/referrals/users/${REF_A}`)
      .set("X-Admin-Token", "admin-test-token");

    assert.equal(res.status, 200);
    assert.equal(res.body.uuid, REF_A);
    assert.equal(res.body.email, "referrer@example.com");
    assert.deepEqual(res.body.subscription, {
      plan: "Premium — 12 месяцев",
      expiresAt: "2030-01-01T00:00:00.000Z",
      status: "active",
    });
    assert.equal(res.body.status.penalized, false);
    assert.equal(res.body.status.pointsBlocked, false);

    const refreshed = await request(app)
      .get(`/api/admin/referrals/users/${REF_A}?refresh=1`)
      .set("X-Admin-Token", "admin-test-token");
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.subscription.status, "expired");
    assert.equal(refreshed.body.subscription.expiresAt, "2020-01-01T00:00:00.000Z");
    assert.equal(lookupCount, 2);
  });

  it("counts confirmed payments across all transaction pages", async () => {
    const fetchedPages = [];
    globalThis.fetch = async (url, options) => {
      assert.equal(options.headers["X-Api-Key"], process.env.RMW_API_KEY);
      const parsed = new URL(url);
      assert.equal(parsed.pathname, `/v1/users/${REF_A}/transactions`);
      assert.equal(parsed.searchParams.get("limit"), "100");
      const page = Number(parsed.searchParams.get("page"));
      fetchedPages.push(page);
      return new Response(JSON.stringify({
        items: page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ status: index === 0 ? "CONFIRMED" : "CANCELED" }))
          : [{ status: "CONFIRMED" }, { status: "FAILED" }],
        page,
        total_pages: 2,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const res = await request(app)
      .get(`/api/admin/referrals/users/${REF_A}/successful-payments`)
      .set("X-Admin-Token", "admin-test-token");
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 2);
    assert.deepEqual(fetchedPages, [1, 2]);
  });

  it("returns referrer points history from RMW by UUID", async () => {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `${process.env.RMW_API_URL}/v1/users/${REF_A}/referral-points?page=2&limit=10`);
      assert.equal(options.headers["X-Api-Key"], process.env.RMW_API_KEY);
      return new Response(
        JSON.stringify({
          balance: 15,
          items: [{ id: 1, amount: 1, reason: "registration", created_at: "2026-01-01T00:00:00.000Z" }],
          page: 2,
          limit: 10,
          total: 11,
          total_pages: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const res = await request(app)
      .get(`/api/admin/referrals/users/${REF_A}/points?page=2&limit=10`)
      .set("X-Admin-Token", "admin-test-token");

    assert.equal(res.status, 200);
    assert.equal(res.body.balance, 15);
    assert.equal(res.body.page, 2);
    assert.equal(res.body.items[0].reason, "registration");
  });

  it("attaches UA/FP/IP risk signals to registration items in points history", async () => {
    // Seed through recordReferralEvent so the per-referrer Redis index used by
    // queryReferralEvents({ referrerUuid }) is populated.
    const reqWith = (ip, ua) => ({
      ip,
      path: "/api/test",
      socket: { remoteAddress: ip },
      get(name) {
        return name === "User-Agent" ? ua : "";
      },
      log: { warn() {} },
    });

    // Two registrations from the same browser (UA+FP match => critical) and one
    // clean registration with unique fingerprints.
    await recordReferralEvent("ref_verify_ok", reqWith("1.1.1.1", "shared-ua"), {
      referrerUuid: REF_A,
      referredEmailHash: emailHash("user1@example.com"),
      referredUuidPrefix: "user-1",
      fingerprint: "shared-fp",
    });
    await recordReferralEvent("ref_verify_ok", reqWith("2.2.2.2", "shared-ua"), {
      referrerUuid: REF_A,
      referredEmailHash: emailHash("user2@example.com"),
      referredUuidPrefix: "user-2",
      fingerprint: "shared-fp",
    });
    await recordReferralEvent("ref_verify_ok", reqWith("3.3.3.3", "clean-ua"), {
      referrerUuid: REF_A,
      referredEmailHash: emailHash("clean@example.com"),
      referredUuidPrefix: "user-3",
      fingerprint: "clean-fp",
    });

    globalThis.fetch = async (url) => {
      assert.match(String(url), /\/referral-points\?page=1&limit=20$/);
      return new Response(
        JSON.stringify({
          balance: 3,
          items: [
            { id: 1, amount: 1, reason: "registration", referred_user_email: "User1@example.com", created_at: "2026-01-01T00:00:00.000Z" },
            { id: 2, amount: 1, reason: "registration", referred_user_email: "clean@example.com", created_at: "2026-01-02T00:00:00.000Z" },
            { id: 3, amount: 1, reason: "registration", referred_user_email: "expired@example.com", created_at: "2026-01-03T00:00:00.000Z" },
            { id: 4, amount: 5, reason: "tariff_payment", referred_user_email: "user1@example.com", created_at: "2026-01-04T00:00:00.000Z" },
          ],
          page: 1,
          limit: 20,
          total: 4,
          total_pages: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const res = await request(app)
      .get(`/api/admin/referrals/users/${REF_A}/points?page=1&limit=20`)
      .set("X-Admin-Token", "admin-test-token");

    assert.equal(res.status, 200);

    // Email matching must be case-insensitive.
    const flagged = res.body.items.find((item) => item.id === 1);
    assert.ok(flagged.risk);
    assert.equal(flagged.referred_email_hash, emailHash("user1@example.com"));
    assert.equal(flagged.risk.severity, "critical");
    assert.deepEqual(flagged.risk.signals, { ua: true, fp: true, ip: false });
    assert.equal(flagged.risk.duplicateRegistrations, 1);

    const clean = res.body.items.find((item) => item.id === 2);
    assert.ok(clean.risk);
    assert.equal(clean.risk.severity, null);
    assert.deepEqual(clean.risk.signals, { ua: false, fp: false, ip: false });

    // No Redis events for this email (e.g. TTL expired) -> no risk field.
    const expired = res.body.items.find((item) => item.id === 3);
    assert.equal(expired.risk, undefined);

    // Non-registration rows are left untouched.
    const payment = res.body.items.find((item) => item.id === 4);
    assert.equal(payment.risk, undefined);
  });

  it("debits referrer points through RMW by UUID and marks referral status", async () => {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `${process.env.RMW_API_URL}/v1/users/${REF_A}/referral-points/debit`);
      assert.equal(options.method, "POST");
      assert.equal(options.headers["X-Api-Key"], process.env.RMW_API_KEY);
      assert.deepEqual(JSON.parse(options.body), { amount: 7, comment: "fraud adjustment", force: true });
      return new Response(
        JSON.stringify({
          balance: 8,
          transaction: {
            id: 2,
            amount: -7,
            reason: "manual_debit",
            meta: { comment: "fraud adjustment" },
            created_at: "2026-01-02T00:00:00Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const res = await request(app)
      .post(`/api/admin/referrals/users/${REF_A}/points/debit`)
      .set("X-Admin-Token", "admin-test-token")
      .send({ amount: 7, comment: "fraud adjustment", force: true, pointsBlocked: true, penalized: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.balance, 8);
    assert.equal(res.body.transaction.reason, "manual_debit");
    assert.equal(res.body.status.penalized, true);
    assert.equal(res.body.status.pointsBlocked, true);

    await seedEvents([event({ type: "ref_click", referrerUuid: REF_A })]);
    const summary = await getSummary("?days=all&limit=50");
    const refA = summary.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    assert.equal(refA.status.penalized, true);
    assert.equal(refA.status.pointsBlocked, true);
  });

  for (const [label, pointsBlocked, penalized] of [
    ["ordinary", false, false],
    ["penalty", false, true],
    ["blocked", true, false],
    ["blocked penalty", true, true],
  ]) {
    it(`applies ${label} debit flags independently and records the reason`, async () => {
      let rmwCalls = 0;
      globalThis.fetch = async (_url, options) => {
        rmwCalls += 1;
        assert.deepEqual(JSON.parse(options.body), { amount: 7, comment: "ручная корректировка", force: true });
        return new Response(JSON.stringify({ balance: 8, transaction: { id: 2, reason: "manual_debit", meta: { comment: "ручная корректировка" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const res = await request(app)
        .post(`/api/admin/referrals/users/${REF_A}/points/debit`)
        .set("X-Admin-Token", "admin-test-token")
        .send({ amount: 7, comment: "ручная корректировка", force: true, pointsBlocked, penalized });

      assert.equal(res.status, 200);
      assert.equal(rmwCalls, 1);
      assert.equal(res.body.status.penalized, penalized);
      assert.equal(res.body.status.pointsBlocked, pointsBlocked);
      assert.equal(Boolean(res.body.status.penalizedAt), penalized);
      assert.equal(res.body.status.lastDebitAmount, 7);
      assert.equal(res.body.status.lastDebitComment, "ручная корректировка");
      assert.equal(res.body.transaction.meta.comment, "ручная корректировка");
    });
  }

  it("clears an existing penalty on an ordinary debit and dates a later penalty anew", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ balance: 8 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const debit = (body) => request(app)
      .post(`/api/admin/referrals/users/${REF_A}/points/debit`)
      .set("X-Admin-Token", "admin-test-token")
      .send({ amount: 1, comment: "корректировка", ...body });

    const first = await debit({ penalized: true, pointsBlocked: true });
    assert.equal(first.status, 200);
    const firstPenaltyAt = first.body.status.penalizedAt;
    const repeated = await debit({ penalized: true });
    assert.equal(repeated.body.status.penalizedAt, firstPenaltyAt);

    const ordinary = await debit({});
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.body.status.penalized, false);
    assert.equal(ordinary.body.status.penalizedAt, null);
    assert.equal(ordinary.body.status.pointsBlocked, true);
    assert.equal(ordinary.body.status.lastDebitComment, "корректировка");

    const next = await debit({ penalized: true });
    assert.equal(next.body.status.penalized, true);
    assert.ok(next.body.status.penalizedAt);
    assert.equal(next.body.status.pointsBlocked, true);
  });

  it("leaves referral status unchanged when RMW rejects the debit", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "RMW error" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    const before = await blockReferralPoints(REF_A);
    assert.equal(before.status, 200);

    const res = await request(app)
      .post(`/api/admin/referrals/users/${REF_A}/points/debit`)
      .set("X-Admin-Token", "admin-test-token")
      .send({ amount: 1, comment: "корректировка", penalized: true });

    assert.equal(res.status, 400);
    const status = await redis.hgetall(refUserStatusKey(REF_A));
    assert.equal(status.penalized, undefined);
    assert.equal(status.pointsBlocked, "1");
    assert.equal(status.lastDebitComment, undefined);
  });

  it("requires an amount and reason before assigning a penalty", async () => {
    const res = await request(app)
      .post(`/api/admin/referrals/users/${REF_A}/points/debit`)
      .set("X-Admin-Token", "admin-test-token")
      .send({ penalized: true, pointsBlocked: true });
    assert.equal(res.status, 400);
    assert.deepEqual(await redis.hgetall(refUserStatusKey(REF_A)), {});
  });

  it("blocks referral points without calling RMW when debit fields are empty", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("RMW should not be called");
    };

    const res = await request(app)
      .post(`/api/admin/referrals/users/${REF_A}/points/debit`)
      .set("X-Admin-Token", "admin-test-token")
      .send({ pointsBlocked: true });

    assert.equal(res.status, 200);
    assert.equal(fetchCalled, false);
    assert.equal(res.body.balance, undefined);
    assert.equal(res.body.transaction, undefined);
    assert.equal(res.body.status.penalized, false);
    assert.equal(res.body.status.pointsBlocked, true);

    await seedEvents([event({ type: "ref_click", referrerUuid: REF_A })]);
    const summary = await getSummary("?days=all&limit=50");
    const refA = summary.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    assert.equal(refA.status.penalized, false);
    assert.equal(refA.status.pointsBlocked, true);
  });

  it("unblocks referral points without calling RMW when debit fields are empty", async () => {
    globalThis.fetch = async () => {
      throw new Error("RMW should not be called");
    };

    const blockRes = await request(app)
      .post(`/api/admin/referrals/users/${REF_A}/points/debit`)
      .set("X-Admin-Token", "admin-test-token")
      .send({ pointsBlocked: true });

    assert.equal(blockRes.status, 200);
    assert.equal(blockRes.body.status.pointsBlocked, true);

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("RMW should not be called");
    };

    const res = await request(app)
      .post(`/api/admin/referrals/users/${REF_A}/points/debit`)
      .set("X-Admin-Token", "admin-test-token")
      .send({});

    assert.equal(res.status, 200);
    assert.equal(fetchCalled, false);
    assert.equal(res.body.balance, undefined);
    assert.equal(res.body.transaction, undefined);
    assert.equal(res.body.status.penalized, false);
    assert.equal(res.body.status.pointsBlocked, false);
    assert.equal(res.body.status.pointsBlockedAt, null);
  });

  it("blocks current user's referral exchange status for high risk", async () => {
    const agent = await createSessionAgent(REF_A);
    // Same IP (and therefore same User-Agent from the fake request) across two
    // different registrations -> IP+UA match -> high risk -> exchange blocked.
    for (let idx = 0; idx < 2; idx += 1) {
      await recordReferralEvent("ref_verify_ok", fakeReferralReq("127.0.0.1"), {
        referrerUuid: REF_A,
        referredEmailHash: `email-${idx}`,
        referredUuidPrefix: `user-${idx}`,
      });
    }

    const res = await agent.get("/api/me/referrals/status");

    assert.equal(res.status, 200);
    assert.equal(res.body.riskLevel, "high");
    assert.equal(res.body.blocked, true);
    assert.ok(
      res.body.warnings.some(
        (warning) => warning.code === "duplicate_registration_signals" && warning.severity === "high",
      ),
    );
  });

  it("creates referral exchange requests for days and prizes", async () => {
    mockReferralPointsFetch({ balance: 2000 });
    const agent = await createSessionAgent(REF_A);

    const daysRes = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 3, points: 30 });

    assert.equal(daysRes.status, 201);
    assert.equal(daysRes.body.request.type, "days");
    assert.equal(daysRes.body.request.points, 30);
    assert.equal(daysRes.body.request.payload.days, 3);

    const prizeRes = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({
        type: "prize",
        prizeId: "phone-card-500",
        prizeTitle: "500 руб на баланс телефона или карту",
        details: "+79990000000",
        points: 500,
      });

    assert.equal(prizeRes.status, 201);
    assert.equal(prizeRes.body.request.type, "prize");
    assert.equal(prizeRes.body.request.payload.details, "+79990000000");

    const myRequests = await agent.get("/api/me/referrals/exchange-requests");
    assert.equal(myRequests.status, 200);
    assert.equal(myRequests.body.items.length, 2);
  });

  it("rejects exchange request creation when pending requests exceed current balance", async () => {
    mockReferralPointsFetch({ balance: 40 });
    const agent = await createSessionAgent(REF_A);

    const firstRes = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 3, points: 30 });
    assert.equal(firstRes.status, 201);

    const secondRes = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 2, points: 20 });
    assert.equal(secondRes.status, 400);
    assert.match(secondRes.body.error, /Недостаточно баллов/);
  });

  it("rejects prize exchange requests with tampered cost", async () => {
    mockReferralPointsFetch({ balance: 2000 });
    const agent = await createSessionAgent(REF_A);

    const res = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({
        type: "prize",
        prizeId: "phone-card-1000",
        prizeTitle: "1000 руб на баланс телефона или карту",
        details: "+79990000000",
        points: 1,
      });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Некорректный приз/);
  });

  it("blocks exchange request creation for points-blocked users", async () => {
    globalThis.fetch = async () => {
      throw new Error("RMW should not be called");
    };
    await request(app)
      .post(`/api/admin/referrals/users/${REF_A}/points/debit`)
      .set("X-Admin-Token", "admin-test-token")
      .send({ pointsBlocked: true });

    const agent = await createSessionAgent(REF_A);
    const res = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 1, points: 10 });

    assert.equal(res.status, 403);
    assert.match(res.body.error, /Списание\/обмен баллов недоступны/);
  });

  it("requires an admin token to manage the exchange permission", async () => {
    const grantRes = await request(app)
      .post(`/api/admin/referrals/users/${REF_A}/exchange-permission`)
      .send({ comment: "нет токена", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(grantRes.status, 401);

    const revokeRes = await request(app).post(
      `/api/admin/referrals/users/${REF_A}/exchange-permission/revoke`,
    );
    assert.equal(revokeRes.status, 401);
  });

  it("requires a comment and a future expiry to grant the exchange permission", async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();

    const missingComment = await grantExchangePermission(REF_A, { comment: "   ", expiresAt });
    assert.equal(missingComment.status, 400);
    assert.match(missingComment.body.error, /комментарий/i);

    const invalidExpiry = await grantExchangePermission(REF_A, { expiresAt: "не дата" });
    assert.equal(invalidExpiry.status, 400);
    assert.match(invalidExpiry.body.error, /корректную дату/i);

    const pastExpiry = await grantExchangePermission(REF_A, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(pastExpiry.status, 400);
    assert.match(pastExpiry.body.error, /в будущем/i);

    const granted = await grantExchangePermission(REF_A, { comment: "тикет 42", expiresAt });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.status.exchangeAllowed, true);
    assert.equal(granted.body.status.exchangeAllowActive, true);
    assert.equal(granted.body.status.exchangeAllowComment, "тикет 42");
    assert.equal(granted.body.status.exchangeAllowedUntil, expiresAt);
    assert.ok(granted.body.status.exchangeAllowedAt);
    assert.equal(granted.body.status.exchangeAllowRevokedAt, null);
  });

  it("exposes the exchange permission in the admin profile and summary", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ user: { uuid: REF_A, email: "referrer@example.com" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    await grantExchangePermission(REF_A, { comment: "видно админам", expiresAt });

    const profile = await request(app)
      .get(`/api/admin/referrals/users/${REF_A}`)
      .set("X-Admin-Token", "admin-test-token");
    assert.equal(profile.status, 200);
    assert.equal(profile.body.status.exchangeAllowActive, true);
    assert.equal(profile.body.status.exchangeAllowComment, "видно админам");
    assert.equal(profile.body.status.exchangeAllowedUntil, expiresAt);

    await seedEvents([event({ type: "ref_click", referrerUuid: REF_A })]);
    const summary = await getSummary("?days=all&limit=50");
    const refA = summary.body.referrers.find((referrer) => referrer.referrerUuid === REF_A);
    assert.equal(refA.status.exchangeAllowActive, true);
    assert.equal(refA.status.exchangeAllowComment, "видно админам");
  });

  it("allows points-blocked users with an active permission to create exchange requests", async () => {
    const blockRes = await blockReferralPoints(REF_A);
    assert.equal(blockRes.body.status.pointsBlocked, true);
    await grantExchangePermission(REF_A);

    mockReferralPointsFetch({ balance: 100 });
    const agent = await createSessionAgent(REF_A);

    const statusRes = await agent.get("/api/me/referrals/status");
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.blocked, false);
    assert.equal(statusRes.body.exchangeAllowed, true);
    // The permission covers the exchange only; accrual stays blocked.
    assert.equal(statusRes.body.pointsBlocked, true);

    const res = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 1, points: 10 });
    assert.equal(res.status, 201);
    assert.equal(res.body.request.points, 10);
  });

  it("allows high-risk users with an active permission to create exchange requests", async () => {
    await seedHighRiskRegistrations(REF_A);
    await grantExchangePermission(REF_A);

    mockReferralPointsFetch({ balance: 100 });
    const agent = await createSessionAgent(REF_A);

    const statusRes = await agent.get("/api/me/referrals/status");
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.riskLevel, "high");
    assert.equal(statusRes.body.blocked, false);
    assert.equal(statusRes.body.exchangeAllowed, true);

    const res = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 1, points: 10 });
    assert.equal(res.status, 201);
  });

  it("blocks the exchange again right after the permission is revoked", async () => {
    await blockReferralPoints(REF_A);
    await seedHighRiskRegistrations(REF_B);
    await grantExchangePermission(REF_A);
    await grantExchangePermission(REF_B);

    const revoked = await revokeExchangePermission(REF_A);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.status.exchangeAllowed, false);
    assert.equal(revoked.body.status.exchangeAllowActive, false);
    assert.ok(revoked.body.status.exchangeAllowRevokedAt);
    // The expired grant stays readable as an audit record.
    assert.equal(revoked.body.status.exchangeAllowComment, "согласовано с поддержкой");
    assert.ok(revoked.body.status.exchangeAllowedUntil);
    // Revoking the exchange permission must not touch the accrual block.
    assert.equal(revoked.body.status.pointsBlocked, true);

    await revokeExchangePermission(REF_B);

    mockReferralPointsFetch({ balance: 100 });
    const blockedAgent = await createSessionAgent(REF_A);
    const blockedRes = await blockedAgent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 1, points: 10 });
    assert.equal(blockedRes.status, 403);
    assert.match(blockedRes.body.error, /Списание\/обмен баллов недоступны/);

    const riskyAgent = await createSessionAgent(REF_B);
    const riskyRes = await riskyAgent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 1, points: 10 });
    assert.equal(riskyRes.status, 403);
  });

  it("stops honouring the permission once its expiry passes", async () => {
    await blockReferralPoints(REF_A);
    await grantExchangePermission(REF_A);

    // The permission has no background job: rewriting the stored deadline into
    // the past is enough for the next read to treat it as expired.
    await redis.hset(refUserStatusKey(REF_A), {
      exchangeAllowedUntil: new Date(Date.now() - 1000).toISOString(),
    });

    mockReferralPointsFetch({ balance: 100 });
    const agent = await createSessionAgent(REF_A);

    const statusRes = await agent.get("/api/me/referrals/status");
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.exchangeAllowed, false);
    assert.equal(statusRes.body.blocked, true);

    const res = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 1, points: 10 });
    assert.equal(res.status, 403);

    const profile = await request(app)
      .get(`/api/admin/referrals/users/${REF_A}`)
      .set("X-Admin-Token", "admin-test-token");
    assert.equal(profile.body.status.exchangeAllowed, true);
    assert.equal(profile.body.status.exchangeAllowActive, false);
  });

  it("keeps risk, warnings and accrual history untouched when the permission is granted", async () => {
    await seedHighRiskRegistrations(REF_A);
    const debitRes = await blockReferralPoints(REF_A);
    const statusBefore = debitRes.body.status;

    await grantExchangePermission(REF_A);

    const agent = await createSessionAgent(REF_A);
    const statusRes = await agent.get("/api/me/referrals/status");
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.riskLevel, "high");
    assert.equal(statusRes.body.pointsBlocked, true);
    assert.equal(statusRes.body.penalized, statusBefore.penalized);
    assert.equal(statusRes.body.status.pointsBlockedAt, statusBefore.pointsBlockedAt);
    assert.ok(
      statusRes.body.warnings.some((warning) => warning.code === "duplicate_registration_signals"),
    );

    // No anti-fraud event is recorded for the permission itself.
    const events = await request(app)
      .get("/api/admin/referrals/events")
      .set("X-Admin-Token", "admin-test-token");
    assert.equal(events.status, 200);
    assert.equal(events.body.events.length, 2);
    assert.ok(events.body.events.every((item) => item.type === "ref_verify_ok"));
  });

  it("shows pending exchange requests to admin", async () => {
    mockReferralPointsFetch({ balance: 100 });
    const agent = await createSessionAgent(REF_A);
    await agent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 2, points: 20 });

    const res = await request(app)
      .get("/api/admin/referrals/exchange-requests?status=pending")
      .set("X-Admin-Token", "admin-test-token");

    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].referrerUuid, REF_A);
    assert.equal(res.body.items[0].status, "pending");
  });

  it("approves day exchange requests through RMW exchange-days and prevents repeated approval", async () => {
    mockReferralPointsFetch({ balance: 100 });
    const agent = await createSessionAgent(REF_A);
    const createRes = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 2, points: 20 });
    const requestId = createRes.body.request.id;

    let exchangeCalls = 0;
    globalThis.fetch = async (url, options) => {
      exchangeCalls += 1;
      assert.equal(url, `${process.env.RMW_API_URL}/v1/users/${REF_A}/referral-points/exchange-days`);
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), {
        points: 20,
        days: 2,
        force: false,
      });
      return new Response(
        JSON.stringify({
          balance: 80,
          transaction: { id: 55, amount: -20, reason: "referral_exchange_days", created_at: "2026-01-03T00:00:00Z" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const approveRes = await request(app)
      .post(`/api/admin/referrals/exchange-requests/${requestId}/approve`)
      .set("X-Admin-Token", "admin-test-token")
      .send({ comment: "added manually" });

    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.request.status, "approved");
    assert.equal(approveRes.body.request.operatorComment, "added manually");
    assert.equal(approveRes.body.exchange.balance, 80);
    assert.equal(exchangeCalls, 1);

    const visibleRes = await agent.get("/api/me/referrals/exchange-requests");
    assert.equal(visibleRes.status, 200);
    assert.equal(visibleRes.body.items.length, 0);

    const repeatRes = await request(app)
      .post(`/api/admin/referrals/exchange-requests/${requestId}/approve`)
      .set("X-Admin-Token", "admin-test-token")
      .send({});

    assert.equal(repeatRes.status, 409);
    assert.equal(exchangeCalls, 1);

    const pendingRes = await request(app)
      .get("/api/admin/referrals/exchange-requests?status=pending")
      .set("X-Admin-Token", "admin-test-token");
    assert.equal(pendingRes.body.items.length, 0);
  });

  for (const type of ["days", "prize"]) {
    for (const [label, forceValue, expectedForce] of [
      ["true", true, true],
      ["false", false, false],
      ["string true", "true", false],
      ["omitted", undefined, false],
    ]) {
      it(`passes force=${label} to RMW when approving a ${type} request`, async () => {
        mockReferralPointsFetch({ balance: 1000 });
        const agent = await createSessionAgent(REF_A);
        const createRes = await agent
          .post("/api/me/referrals/exchange-requests")
          .send(type === "days"
            ? { type, days: 2, points: 20 }
            : { type, prizeId: "phone-card-500", prizeTitle: "500 руб на баланс телефона или карту", details: "+79990000000", points: 500 });
        assert.equal(createRes.status, 201);

        let rmwCalls = 0;
        globalThis.fetch = async (url, options) => {
          rmwCalls += 1;
          assert.equal(
            url,
            `${process.env.RMW_API_URL}/v1/users/${REF_A}/referral-points/${type === "days" ? "exchange-days" : "debit"}`,
          );
          const body = JSON.parse(options.body);
          if (type === "days") {
            assert.deepEqual(body, { points: 20, days: 2, force: expectedForce });
          } else {
            assert.deepEqual(body, {
              amount: 500,
              comment: "выдано оператором",
              ...(expectedForce ? { force: true } : {}),
            });
          }
          return new Response(JSON.stringify({ balance: 500, transaction: { id: 56 } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        };

        const approveRes = await request(app)
          .post(`/api/admin/referrals/exchange-requests/${createRes.body.request.id}/approve`)
          .set("X-Admin-Token", "admin-test-token")
          .send({ comment: "выдано оператором", ...(forceValue === undefined ? {} : { force: forceValue }) });

        assert.equal(approveRes.status, 200);
        assert.equal(approveRes.body.request.status, "approved");
        assert.equal(rmwCalls, 1);
      });
    }
  }

  it("keeps day exchange request pending when RMW exchange-days fails", async () => {
    mockReferralPointsFetch({ balance: 100 });
    const agent = await createSessionAgent(REF_A);
    const createRes = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 2, points: 20 });
    const requestId = createRes.body.request.id;

    globalThis.fetch = async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), {
        points: 20,
        days: 2,
        force: false,
      });
      return new Response(JSON.stringify({ error: "not enough points" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    };

    const approveRes = await request(app)
      .post(`/api/admin/referrals/exchange-requests/${requestId}/approve`)
      .set("X-Admin-Token", "admin-test-token")
      .send({});

    assert.equal(approveRes.status, 400);

    const pendingRes = await request(app)
      .get("/api/admin/referrals/exchange-requests?status=pending")
      .set("X-Admin-Token", "admin-test-token");
    assert.equal(pendingRes.body.items.length, 1);
    assert.equal(pendingRes.body.items[0].id, requestId);
  });

  it("rejects exchange requests without calling RMW", async () => {
    mockReferralPointsFetch({ balance: 100 });
    const agent = await createSessionAgent(REF_A);
    const createRes = await agent
      .post("/api/me/referrals/exchange-requests")
      .send({ type: "days", days: 2, points: 20 });
    const requestId = createRes.body.request.id;

    globalThis.fetch = async () => {
      throw new Error("RMW should not be called");
    };

    const rejectRes = await request(app)
      .post(`/api/admin/referrals/exchange-requests/${requestId}/reject`)
      .set("X-Admin-Token", "admin-test-token")
      .send({});

    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.body.request.status, "rejected");
    assert.equal(rejectRes.body.request.operatorComment, "Отклонено оператором");

    const visibleRes = await agent.get("/api/me/referrals/exchange-requests");
    assert.equal(visibleRes.status, 200);
    assert.equal(visibleRes.body.items.length, 1);
    assert.equal(visibleRes.body.items[0].status, "rejected");
    assert.equal(visibleRes.body.items[0].operatorComment, "Отклонено оператором");

    const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await redis.hset(refExchangeRequestKey(requestId), { closedAt: expiredAt });
    const expiredVisibleRes = await agent.get("/api/me/referrals/exchange-requests");
    assert.equal(expiredVisibleRes.status, 200);
    assert.equal(expiredVisibleRes.body.items.length, 0);

    const repeatRes = await request(app)
      .post(`/api/admin/referrals/exchange-requests/${requestId}/reject`)
      .set("X-Admin-Token", "admin-test-token")
      .send({});
    assert.equal(repeatRes.status, 409);
  });
});
