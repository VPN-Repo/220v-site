import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "silent";

const API_KEY = "test-unisender-key-$&-not-real";

const { redis } = await import("../redis.mjs");
const {
  BOUNCE_TTL_SEC,
  CATEGORY_MESSAGES,
  WEBHOOK_PATH,
  categorizeEmailStatus,
  createUnisenderWebhookRouter,
  verifyUnisenderAuth,
} = await import("../email/unisenderBounces.mjs");
const { UNISENDER_BRAND } = await import("../email/unisenderBrand.mjs");
const { mailBounceKey, otpCooldownKey } = await import("../auth/keys.mjs");
const { createAuthRouter } = await import("../auth/routes.mjs");

const logs = [];
const captureLog = {
  info: (obj, msg) => logs.push({ level: "info", obj, msg }),
  warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
  error: (obj, msg) => logs.push({ level: "error", obj, msg }),
  debug() {},
};

const webhookApp = express();
// Like production: the webhook router runs before express.json.
webhookApp.use(createUnisenderWebhookRouter({ log: captureLog }));
webhookApp.use(express.json({ limit: "16kb" }));

const quietLog = { info() {}, warn() {}, debug() {}, error() {} };
const authApp = express();
authApp.set("trust proxy", 1);
let clientIp = 0;
const nextIp = () => `203.0.113.${(clientIp++ % 250) + 1}`;
authApp.use(express.json());
authApp.use(cookieParser());
authApp.use((req, _res, next) => { req.log = quietLog; next(); });
authApp.use(createAuthRouter({
  mailer: { sendOtpEmail: async () => ({ ok: true, messageId: "<1@test>", provider: "primary", failover: false }) },
  loadUserProfile: async () => ({ user: { userUuid: "b6810e6c-8a69-42b1-b298-8b07d8378987" } }),
  extractUserUuid: (profile) => profile.user?.userUuid || null,
}));

function statusEvent(email, status, deliveryStatus, brand = UNISENDER_BRAND) {
  const eventData = { job_id: "1a3Q2V-0000OZ-S0", email, status, event_time: "2026-10-18 10:00:00" };
  if (brand !== null) eventData.metadata = { brand };
  if (deliveryStatus) eventData.delivery_info = { delivery_status: deliveryStatus, destination_response: "550 test" };
  return { event_name: "transactional_email_status", event_data: eventData };
}

// Builds a body the way Unisender does: md5 over the body with the API key in place of auth.
function signedBody(events, key = API_KEY) {
  const template = (auth) =>
    JSON.stringify({ auth, events_by_user: [{ user_id: 456, events }] });
  const auth = createHash("md5").update(template(key)).digest("hex");
  return template(auth);
}

const postWebhook = (body, headers = {}) =>
  request(webhookApp)
    .post(WEBHOOK_PATH)
    .set({ "Content-Type": "application/json", ...headers })
    .send(body);

const bounce = async (email) => {
  const raw = await redis.get(mailBounceKey(email));
  return raw ? JSON.parse(raw) : null;
};

beforeEach(async () => {
  await redis.flushdb();
  logs.length = 0;
  process.env.UNISENDER_API_KEY = API_KEY;
});

after(async () => {
  delete process.env.UNISENDER_API_KEY;
  await redis.quit();
});

describe("unisender webhook auth", () => {
  it("answers the registration GET with 200 ok", async () => {
    const res = await request(webhookApp).get(WEBHOOK_PATH);
    assert.equal(res.status, 200);
    assert.equal(res.text, "ok");
  });

  it("accepts a correctly signed body", async () => {
    const res = await postWebhook(signedBody([statusEvent("ivan@example.com", "hard_bounced", "err_user_unknown")]));
    assert.equal(res.status, 200);
    assert.equal((await bounce("ivan@example.com")).category, "invalid_address");
  });

  it("rejects a wrong auth with 403 and stores nothing", async () => {
    const body = signedBody([statusEvent("ivan@example.com", "hard_bounced", "err_user_unknown")], "other-key");
    const res = await postWebhook(body);
    assert.equal(res.status, 403);
    assert.equal(await bounce("ivan@example.com"), null);
  });

  it("rejects a tampered body with 403", async () => {
    const body = signedBody([statusEvent("ivan@example.com", "delivered", "ok_delivered")]).replace(
      "ok_delivered",
      "err_user_unknown",
    );
    assert.equal((await postWebhook(body)).status, 403);
  });

  it("rejects a missing or malformed auth with 403", async () => {
    assert.equal((await postWebhook(JSON.stringify({ events_by_user: [] }))).status, 403);
    assert.equal((await postWebhook(JSON.stringify({ auth: "zz", events_by_user: [] }))).status, 403);
  });

  it("returns 503 and does nothing without UNISENDER_API_KEY", async () => {
    delete process.env.UNISENDER_API_KEY;
    const res = await postWebhook(signedBody([statusEvent("ivan@example.com", "hard_bounced", "err_user_unknown")]));
    assert.equal(res.status, 503);
    assert.equal(await bounce("ivan@example.com"), null);
  });

  it("treats `$` in the API key literally", () => {
    const body = signedBody([]);
    const auth = JSON.parse(body).auth;
    assert.equal(verifyUnisenderAuth(body, auth, API_KEY), true);
    assert.equal(verifyUnisenderAuth(body, auth.toUpperCase(), API_KEY), false);
  });

  it("decompresses a gzip body before checking auth", async () => {
    const body = signedBody([statusEvent("ivan@example.com", "hard_bounced", "err_mailbox_full")]);
    const res = await request(webhookApp)
      .post(WEBHOOK_PATH)
      .set({ "Content-Type": "application/json", "Content-Encoding": "gzip" })
      .serialize((data) => data)
      .send(gzipSync(Buffer.from(body)));
    assert.equal(res.status, 200);
    assert.equal((await bounce("ivan@example.com")).category, "mailbox_full");
  });

  it("accepts bodies above the 16 KB API limit and rejects ones above 1 MB", async () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      statusEvent(`user${i}@example.com`, "hard_bounced", "err_user_unknown"),
    );
    const body = signedBody(events);
    assert.ok(body.length > 16 * 1024);
    assert.equal((await postWebhook(body)).status, 200);
    assert.equal((await bounce("user99@example.com")).category, "invalid_address");

    const huge = JSON.stringify({ auth: "0".repeat(32), pad: "x".repeat(1024 * 1024) });
    assert.equal((await postWebhook(huge)).status, 413);
  });
});

describe("unisender webhook events", () => {
  it("ignores events of other brands, events without a brand and spam-block events", async () => {
    const res = await postWebhook(
      signedBody([
        statusEvent("leto@example.com", "hard_bounced", "err_user_unknown", "leto"),
        statusEvent("pavel@example.com", "hard_bounced", "err_user_unknown", "pavel"),
        statusEvent("nobrand@example.com", "hard_bounced", "err_user_unknown", null),
        statusEvent("mine@example.com", "hard_bounced", "err_user_unknown"),
        { event_name: "transactional_spam_block", event_data: { domain: "example.com", domain_status: "blocked" } },
      ]),
    );
    assert.equal(res.status, 200);
    assert.equal(await bounce("leto@example.com"), null);
    assert.equal(await bounce("pavel@example.com"), null);
    assert.equal(await bounce("nobrand@example.com"), null);
    assert.equal((await bounce("mine@example.com")).category, "invalid_address");
  });

  it("stores the bounce with deliveryStatus, timestamp and the category TTL", async () => {
    const cases = [
      ["a@example.com", "hard_bounced", "err_user_unknown", "invalid_address"],
      ["b@example.com", "hard_bounced", "err_mailbox_full", "mailbox_full"],
      ["c@example.com", "hard_bounced", "err_spam_rejected", "blocked_or_spam"],
      ["d@example.com", "hard_bounced", "err_unsubscribed", "unsubscribed"],
    ];
    await postWebhook(signedBody(cases.map(([email, status, ds]) => statusEvent(email, status, ds))));
    for (const [email, , ds, category] of cases) {
      const record = await bounce(email);
      assert.equal(record.category, category);
      assert.equal(record.deliveryStatus, ds);
      assert.ok(!Number.isNaN(Date.parse(record.at)));
      const ttl = await redis.ttl(mailBounceKey(email));
      assert.ok(ttl > BOUNCE_TTL_SEC[category] - 5 && ttl <= BOUNCE_TTL_SEC[category], `${category} ttl ${ttl}`);
    }
    assert.equal(BOUNCE_TTL_SEC.invalid_address, 30 * 86400);
    assert.equal(BOUNCE_TTL_SEC.mailbox_full, 3 * 86400);
    assert.equal(BOUNCE_TTL_SEC.blocked_or_spam, 7 * 86400);
    assert.equal(BOUNCE_TTL_SEC.unsubscribed, 30 * 86400);
  });

  it("normalizes the address before storing", async () => {
    await postWebhook(signedBody([statusEvent(" Ivan@Example.COM ", "hard_bounced", "err_user_unknown")]));
    assert.equal((await bounce("ivan@example.com")).category, "invalid_address");
  });

  it("clears the bounce on delivered, ok_delivered and ok_read", async () => {
    for (const [status, ds] of [["delivered", null], ["delivered", "ok_delivered"], ["opened", "ok_read"]]) {
      await postWebhook(signedBody([statusEvent("ivan@example.com", "hard_bounced", "err_user_unknown")]));
      assert.ok(await bounce("ivan@example.com"));
      await postWebhook(signedBody([statusEvent("ivan@example.com", status, ds)]));
      assert.equal(await bounce("ivan@example.com"), null, `${status}/${ds}`);
    }
  });

  it("applies a batch in order, so the latest event for an address wins", async () => {
    await postWebhook(
      signedBody([
        statusEvent("ivan@example.com", "hard_bounced", "err_user_unknown"),
        statusEvent("ivan@example.com", "delivered", "ok_delivered"),
        statusEvent("olga@example.com", "delivered", "ok_delivered"),
        statusEvent("olga@example.com", "hard_bounced", "err_mailbox_full"),
      ]),
    );
    assert.equal(await bounce("ivan@example.com"), null);
    assert.equal((await bounce("olga@example.com")).category, "mailbox_full");
  });

  it("only logs temporary_retry and ignore", async () => {
    await postWebhook(
      signedBody([
        statusEvent("a@example.com", "soft_bounced", "err_will_retry"),
        statusEvent("b@example.com", "sent", "ok_sent"),
        statusEvent("c@example.com", "hard_bounced", "err_lost"),
      ]),
    );
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) assert.equal(await bounce(email), null);
    const categories = logs.filter((l) => l.msg === "unisender email status").map((l) => l.obj.category);
    assert.deepEqual(categories, ["temporary_retry", "ignore", "temporary_retry"]);
  });

  it("never logs the full address, only the masked form", async () => {
    await postWebhook(signedBody([statusEvent("secretname@example.com", "hard_bounced", "err_user_unknown")]));
    const dump = JSON.stringify(logs);
    assert.ok(!dump.includes("secretname@example.com"));
    assert.ok(dump.includes("se***@example.com"));
  });
});

describe("category mapping", () => {
  const expected = {
    invalid_address: [
      "err_user_unknown", "err_user_inactive", "err_mailbox_discarded", "err_dest_invalid",
      "err_domain_inactive", "err_no_dns", "err_no_smtp",
    ],
    mailbox_full: ["err_mailbox_full", "skip_dup_mailbox_full"],
    blocked_or_spam: [
      "ok_spam_folder", "err_spam_rejected", "err_spam_skipped", "err_spam_removed", "err_blacklisted",
      "err_unreachable", "skip_dup_unreachable", "err_not_available", "err_skip_letter",
      "skip_dup_temp_unreachable", "err_destination_misconfigured", "err_too_large", "err_delivery_failed",
      "err_giveup", "err_unknown", "not_sent",
    ],
    unsubscribed: ["ok_unsubscribed", "err_unsubscribed", "ok_fbl"],
    temporary_retry: ["err_will_retry", "err_retry_letter", "err_lost", "err_internal", "err_resend", "err_src_invalid"],
    ignore: ["ok_accepted", "ok_sent", "ok_delivered", "ok_read", "ok_link_visited", "ok_resubscribed"],
  };

  for (const [category, statuses] of Object.entries(expected)) {
    it(`maps ${category}`, () => {
      for (const ds of statuses) assert.equal(categorizeEmailStatus("hard_bounced", ds), category, ds);
    });
  }

  it("falls back on the top-level status for unknown or missing delivery statuses", () => {
    assert.equal(categorizeEmailStatus("soft_bounced", "err_brand_new"), "temporary_retry");
    assert.equal(categorizeEmailStatus("hard_bounced", "err_brand_new"), "blocked_or_spam");
    assert.equal(categorizeEmailStatus("hard_bounced", null), "blocked_or_spam");
    assert.equal(categorizeEmailStatus("spam", null), "blocked_or_spam");
    assert.equal(categorizeEmailStatus("unsubscribed", null), "unsubscribed");
    assert.equal(categorizeEmailStatus("delivered", "ok_brand_new"), "ignore");
    assert.equal(categorizeEmailStatus("sent", undefined), "ignore");
    assert.equal(categorizeEmailStatus("toString", "constructor"), "ignore");
  });

  it("has an approved text for every user-facing category", () => {
    for (const category of ["invalid_address", "mailbox_full", "blocked_or_spam", "unsubscribed", "temporary_retry"]) {
      assert.ok(CATEGORY_MESSAGES[category]);
    }
  });
});

describe("login screen delivery warning", () => {
  const sendCode = (email) =>
    request(authApp).post("/api/auth/send-code").set("X-Forwarded-For", nextIp()).send({ email });
  const deliveryStatus = (email, cookie) => {
    const req = request(authApp)
      .get("/api/auth/delivery-status")
      .query({ email })
      .set("X-Forwarded-For", nextIp());
    return cookie ? req.set("Cookie", cookie) : req;
  };
  const pendingCookie = (res) =>
    (res.headers["set-cookie"] || []).find((c) => c.startsWith("v220_otp_pending="))?.split(";")[0];
  const storeBounce = (email, category) =>
    redis.set(mailBounceKey(email), JSON.stringify({ category, deliveryStatus: "x", at: new Date().toISOString() }));

  it("still sends the code and adds deliveryWarning for a known bounce", async () => {
    await storeBounce("ivan@gmail.com", "mailbox_full");
    const res = await sendCode("ivan@gmail.com");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.deliveryWarning, {
      category: "mailbox_full",
      message: CATEGORY_MESSAGES.mailbox_full,
    });
  });

  it("has no deliveryWarning without a bounce, and sets an httpOnly pending cookie", async () => {
    const res = await sendCode("ivan@gmail.com");
    assert.equal(res.status, 200);
    assert.equal(res.body.deliveryWarning, undefined);
    const raw = res.headers["set-cookie"].find((c) => c.startsWith("v220_otp_pending="));
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /Path=\/api\/auth/);
  });

  it("delivery-status answers for the session's pending email only", async () => {
    const res = await sendCode("ivan@gmail.com");
    const cookie = pendingCookie(res);
    assert.deepEqual((await deliveryStatus("ivan@gmail.com", cookie)).body, { warning: null });

    await storeBounce("ivan@gmail.com", "invalid_address");
    assert.deepEqual((await deliveryStatus("Ivan@Gmail.com", cookie)).body, {
      warning: { category: "invalid_address", message: CATEGORY_MESSAGES.invalid_address },
    });

    // Another address with a bounce: not this browser's pending code.
    await storeBounce("olga@gmail.com", "mailbox_full");
    assert.deepEqual((await deliveryStatus("olga@gmail.com", cookie)).body, { warning: null });
    // No cookie, or a stale one after somebody else requested a new code for the address.
    assert.deepEqual((await deliveryStatus("ivan@gmail.com")).body, { warning: null });
    await redis.del(otpCooldownKey("ivan@gmail.com"));
    const other = pendingCookie(await sendCode("ivan@gmail.com"));
    assert.notEqual(other, cookie);
    assert.deepEqual((await deliveryStatus("ivan@gmail.com", cookie)).body, { warning: null });
    assert.equal((await deliveryStatus("ivan@gmail.com", other)).body.warning.category, "invalid_address");
  });

  it("delivery-status returns null for a bad email and is not cached", async () => {
    const res = await deliveryStatus("not-an-email", "v220_otp_pending=abc");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { warning: null });
    assert.equal(res.headers["cache-control"], "no-store");
  });
});
