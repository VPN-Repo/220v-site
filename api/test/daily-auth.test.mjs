import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.ADMIN_REDIS_TOKEN = "daily-auth-test-token";

const { redis } = await import("../redis.mjs");
const { createAuthRouter } = await import("../auth/routes.mjs");
const {
  buildDailyAuthSnapshot,
  dailyAuthKey,
  dailyAuthPendingEmailsKey,
  listDailyUnfinishedEmails,
  moscowDay,
  recordDailyAuth,
} = await import("../auth/dailyStats.mjs");
const { otpCooldownKey, otpKey } = await import("../auth/keys.mjs");

const quietLog = { info() {}, warn() {}, debug() {}, error() {} };
let deliveredCode = "";
let mailFails = false;
let profileFails = false;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.log = quietLog; next(); });
app.use(createAuthRouter({
  mailer: { async sendOtpEmail({ code }) {
    if (mailFails) return { ok: false, error: "test failure" };
    deliveredCode = code;
    return { ok: true };
  } },
  async loadUserProfile() {
    if (profileFails) throw Object.assign(new Error("profile unavailable"), { status: 502 });
    return { userUuid: "b6810e6c-8a69-42b1-b298-8b07d8378987" };
  },
  extractUserUuid(profile) { return profile.userUuid; },
}));

const today = () => buildDailyAuthSnapshot();
const current = async () => (await today()).days[0];
const admin = () => request(app).get("/api/admin/redis-auth")
  .set("X-Admin-Token", process.env.ADMIN_REDIS_TOKEN);
const unfinished = (query = "") => request(app).get(`/api/admin/redis-auth/unfinished${query}`)
  .set("X-Admin-Token", process.env.ADMIN_REDIS_TOKEN);

describe("daily auth statistics", () => {
  beforeEach(async () => {
    await redis.flushall();
    deliveredCode = "";
    mailFails = false;
    profileFails = false;
  });
  after(async () => { await redis.quit(); });

  it("starts empty, protects the snapshot, and counts only accepted mail", async () => {
    assert.deepEqual((await today()).days, []);
    assert.equal((await request(app).get("/api/admin/redis-auth")).status, 401);
    mailFails = true;
    const originalEval = redis.eval;
    redis.eval = async (_script, _keys, otp, cooldown) => redis.del(otp, cooldown);
    try {
      assert.equal((await request(app).post("/api/auth/send-code").send({ email: "one@gmail.com" })).status, 502);
    } finally {
      redis.eval = originalEval;
    }
    assert.equal((await today()).startedAt, null);
    mailFails = false;
    assert.equal((await request(app).post("/api/auth/send-code").send({ email: " ONE@gmail.com " })).status, 200);
    assert.equal((await current()).sent, 1);
    assert.equal((await current()).noCodeSubmitted, 1);
    const response = await admin();
    assert.equal(response.status, 200);
    assert.equal(response.body.dailyAuth.days[0].unfinished, 1);
    assert.equal(response.body.dailyAuth.days[0].preliminary, true);
    assert.equal(response.body.dailyAuth.days[0].partial, true);
    assert.equal((await request(app).get("/api/admin/redis-auth/unfinished")).status, 401);
    assert.equal((await unfinished("?limit=101")).status, 400);
    const emailResponse = await unfinished();
    assert.equal(emailResponse.status, 200);
    assert.equal(emailResponse.headers["cache-control"], "no-store");
    assert.deepEqual(emailResponse.body.items, [{
      date: moscowDay(), email: "one@gmail.com", reason: "no_code_submitted",
    }]);
    const emailTtl = await redis.ttl(dailyAuthPendingEmailsKey(moscowDay()));
    assert.ok(emailTtl > 0 && emailTtl <= 30 * 24 * 60 * 60);
  });

  it("deduplicates retries and removes a user after the correct code, even if profile loading fails", async () => {
    const email = "two@gmail.com";
    assert.equal((await request(app).post("/api/auth/send-code").send({ email })).status, 200);
    assert.equal((await request(app).post("/api/auth/verify").send({ email, code: "00000" })).status, 400);
    assert.equal((await request(app).post("/api/auth/verify").send({ email, code: "00000" })).status, 400);
    assert.deepEqual({ sent: (await current()).sent, failed: (await current()).codeNotAccepted }, { sent: 1, failed: 1 });
    assert.equal((await unfinished()).body.items[0].reason, "code_not_accepted");
    await redis.del(otpCooldownKey(email));
    assert.equal((await request(app).post("/api/auth/send-code").send({ email: "TWO@gmail.com" })).status, 200);
    assert.equal((await current()).sent, 1);
    profileFails = true;
    assert.equal((await request(app).post("/api/auth/verify").send({ email, code: deliveredCode })).status, 502);
    assert.equal((await current()).unfinished, 0);
    assert.equal((await unfinished()).body.total, 0);
    assert.equal(await redis.hlen(dailyAuthPendingEmailsKey(moscowDay())), 0);
  });

  it("counts malformed and expired code submissions, but ignores verification without a send", async () => {
    const email = "three@gmail.com";
    await request(app).post("/api/auth/send-code").send({ email });
    assert.equal((await request(app).post("/api/auth/verify").send({ email, code: 123 })).status, 400);
    assert.equal((await request(app).post("/api/auth/verify").send({ email, code: "" })).status, 400);
    await redis.del(otpKey(email));
    assert.equal((await request(app).post("/api/auth/verify").send({ email, code: "12345" })).status, 400);
    await request(app).post("/api/auth/verify").send({ email: "other@gmail.com", code: "12345" });
    assert.equal((await current()).codeNotAccepted, 1);
    assert.equal((await current()).sent, 1);
    assert.deepEqual((await unfinished()).body.items.map((item) => item.email), [email]);
  });

  it("counts distinct email addresses even when requests come from the same IP", async () => {
    await recordDailyAuth("sent", "first@gmail.com", null);
    await recordDailyAuth("sent", "second@gmail.com", null);
    assert.equal((await current()).sent, 2);
    assert.equal((await current()).noCodeSubmitted, 2);
  });

  it("uses Moscow calendar days, fills quiet days, and retains only the last 30", async () => {
    await recordDailyAuth("sent", "midnight@gmail.com", null, new Date("2026-09-28T20:58:00Z"));
    await recordDailyAuth("confirmed", "midnight@gmail.com", null, new Date("2026-09-28T21:03:00Z"));
    const snapshot = await buildDailyAuthSnapshot(new Date("2026-09-30T12:00:00Z"));
    assert.equal(snapshot.days[0].date, "2026-09-30");
    assert.equal(snapshot.days[0].sent, 0);
    assert.equal(snapshot.days[1].date, "2026-09-29");
    assert.equal(snapshot.days[2].date, "2026-09-28");
    assert.equal(snapshot.days[2].unfinished, 1);
    assert.equal(snapshot.days[2].noCodeSubmitted, 1);
    assert.equal(await redis.ttl(dailyAuthKey("2026-09-28", "sent")) > 0, true);
    assert.equal(await redis.ttl(dailyAuthPendingEmailsKey("2026-09-28")) > 0, true);
    const oldDay = await listDailyUnfinishedEmails({ now: new Date("2026-09-30T12:00:00Z") });
    assert.deepEqual(oldDay.items, [{ date: "2026-09-28", email: "midnight@gmail.com", reason: "no_code_submitted" }]);
    assert.equal((await buildDailyAuthSnapshot(new Date("2026-10-28T12:00:00Z"))).days.length, 30);
    assert.equal((await listDailyUnfinishedEmails({ now: new Date("2026-10-28T12:00:00Z") })).total, 0);
  });

  it("paginates available addresses and reports older hash-only records", async () => {
    await recordDailyAuth("sent", "b@gmail.com", null);
    await recordDailyAuth("sent", "a@gmail.com", null);
    const day = moscowDay();
    await redis.sadd(dailyAuthKey(day, "sent"), "old-hash-without-email");
    const first = (await unfinished("?offset=0&limit=1")).body;
    assert.equal(first.total, 3);
    assert.equal(first.available, 2);
    assert.equal(first.unavailable, 1);
    assert.equal(first.items[0].email, "a@gmail.com");
    const second = (await unfinished("?offset=1&limit=1")).body;
    assert.equal(second.items[0].email, "b@gmail.com");
  });

  it("never stores a pending email when confirmation precedes the sent record", async () => {
    await recordDailyAuth("confirmed", "fast@gmail.com", null);
    await recordDailyAuth("sent", "fast@gmail.com", null);
    assert.equal((await current()).unfinished, 0);
    assert.equal(await redis.hlen(dailyAuthPendingEmailsKey(moscowDay())), 0);
  });

  it("handles concurrent duplicate events independently from the event list", async () => {
    await Promise.all(Array.from({ length: 12 }, () => recordDailyAuth("sent", "same@gmail.com", null)));
    await redis.del("v220:auth:events");
    assert.equal((await current()).sent, 1);
    assert.equal((await current()).unfinished, 1);
  });
});
