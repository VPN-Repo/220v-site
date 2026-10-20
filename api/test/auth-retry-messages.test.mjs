import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "silent";

const { redis } = await import("../redis.mjs");
const { createAuthRouter } = await import("../auth/routes.mjs");
const { saveSession } = await import("../auth/session.mjs");
const { otpCooldownKey, passwordCooldownKey } = await import("../auth/keys.mjs");
const { OTP_MAX_TRIES } = await import("../config.mjs");
const { passwordEmailLimiter, rateLimitRetryAfterSec, sendCodeIpMinuteLimiter } = await import(
  "../http/rateLimit.mjs"
);
const { formatRateLimitMessage, formatWaitTime } = await import("../http/userMessages.mjs");

const quietLog = { info() {}, warn() {}, debug() {}, error() {} };
const sentCodes = [];
const app = express();
// Limiters are in memory under test and shared by the whole file, so each test uses its own client address.
app.set("trust proxy", 1);
let clientIp = 0;
const nextIp = () => `203.0.113.${(clientIp++ % 250) + 1}`;
app.use(express.json());
app.use(cookieParser());
app.use((req, _res, next) => { req.log = quietLog; next(); });
app.get("/limited", sendCodeIpMinuteLimiter, (_req, res) => res.json({ ok: true }));
app.post("/limited-login", passwordEmailLimiter, (_req, res) => res.json({ ok: true }));
app.use(createAuthRouter({
  mailer: {
    async sendOtpEmail({ code }) {
      sentCodes.push(code);
      return { ok: true, messageId: `<${sentCodes.length}@test>`, provider: "primary" };
    },
  },
  loadUserProfile: async () => ({ user: { userUuid: "b6810e6c-8a69-42b1-b298-8b07d8378987" } }),
  extractUserUuid: (profile) => profile.user?.userUuid || null,
}));

const email = "retry-messages@gmail.com";
let ip = nextIp();
const sendCode = () => request(app).post("/api/auth/send-code").set("X-Forwarded-For", ip).send({ email });
const wrongCode = (code) => code.replace(/^./, (digit) => String((Number(digit) + 1) % 10));

beforeEach(async () => {
  await redis.flushdb();
  ip = nextIp();
  sentCodes.length = 0;
});

after(async () => {
  await redis.quit();
});

describe("retry wait formatting", () => {
  it("counts seconds below two minutes and whole minutes, rounded up, above", () => {
    assert.equal(formatWaitTime(45), "45 сек.");
    assert.equal(formatWaitTime(0.2), "1 сек.");
    assert.equal(formatWaitTime(119), "119 сек.");
    assert.equal(formatWaitTime(120), "2 мин.");
    assert.equal(formatWaitTime(121), "3 мин.");
    assert.equal(formatWaitTime(420), "7 мин.");
  });

  it("replaces «Попробуйте позже» in a limiter message with the exact wait", () => {
    assert.equal(
      formatRateLimitMessage("Слишком много попыток входа. Попробуйте позже.", 840),
      "Слишком много попыток входа. Повторите через 14 мин.",
    );
    assert.equal(formatRateLimitMessage("Too many requests", 30), "Too many requests. Повторите через 30 сек.");
  });

  it("takes the wait from the limiter reset time", () => {
    const now = 1_000_000;
    assert.equal(rateLimitRetryAfterSec({ rateLimit: { resetTime: new Date(now + 44_100) } }, 60_000, now), 45);
    assert.equal(rateLimitRetryAfterSec({}, 60_000, now), 60);
    assert.equal(rateLimitRetryAfterSec({ rateLimit: { resetTime: new Date(now - 5) } }, 60_000, now), 1);
  });
});

describe("auth retry messages", () => {
  it("a limiter 429 tells the exact wait in seconds and keeps Retry-After", async () => {
    const hit = () => request(app).get("/limited").set("X-Forwarded-For", ip);
    for (let i = 0; i < 8; i += 1) assert.equal((await hit()).status, 200);
    const res = await hit();
    assert.equal(res.status, 429);
    assert.equal(res.body.code, "rate_limited");
    assert.ok(Number.isInteger(res.body.retryAfterSec));
    assert.ok(res.body.retryAfterSec >= 1 && res.body.retryAfterSec <= 60, String(res.body.retryAfterSec));
    assert.equal(res.body.error, `Слишком много запросов. Повторите через ${res.body.retryAfterSec} сек.`);
    assert.equal(res.headers["retry-after"], String(res.body.retryAfterSec));
  });

  it("a long limiter window is told in minutes", async () => {
    const hit = () => request(app).post("/limited-login").send({ email: "minutes@gmail.com" });
    for (let i = 0; i < 10; i += 1) assert.equal((await hit()).status, 200);
    const res = await hit();
    assert.equal(res.status, 429);
    assert.equal(res.body.code, "rate_limited");
    assert.ok(res.body.retryAfterSec > 14 * 60 && res.body.retryAfterSec <= 15 * 60, String(res.body.retryAfterSec));
    assert.equal(res.body.error, "Слишком много попыток входа. Повторите через 15 мин.");
  });

  it("the resend cooldown 429 tells the remaining seconds", async () => {
    assert.equal((await sendCode()).status, 200);
    await redis.expire(otpCooldownKey(email), 37);
    const res = await sendCode();
    assert.equal(res.status, 429);
    assert.equal(res.body.code, "otp_cooldown");
    assert.equal(res.body.retryAfterSec, 37);
    assert.equal(res.body.error, "Повторный код — через 37 сек.");
    assert.equal(res.headers["retry-after"], "37");
    assert.equal(sentCodes.length, 1);
  });

  it("the password-change resend cooldown tells the remaining seconds too", async () => {
    const sid = "retry-messages-sid";
    const csrf = "retry-messages-csrf";
    await saveSession(sid, {
      userUuid: "b6810e6c-8a69-42b1-b298-8b07d8378987",
      email,
      csrf,
      expAt: Date.now() + 600_000,
    });
    const send = () => request(app)
      .post("/api/auth/password/send-code")
      .set("X-Forwarded-For", ip)
      .set("Cookie", `v220_sid=${sid}; v220_csrf=${csrf}`)
      .set("X-CSRF-Token", csrf)
      .send({});
    const first = await send();
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true, retryAfterSec: 30, sendNumber: 1 });
    await redis.expire(passwordCooldownKey(sid), 21);
    const res = await send();
    assert.equal(res.status, 429);
    assert.equal(res.body.code, "otp_cooldown");
    assert.equal(res.body.retryAfterSec, 21);
    assert.equal(res.body.error, "Повторный код — через 21 сек.");
  });

  it("a wrong code returns the attempt number and the attempts left", async () => {
    assert.equal((await sendCode()).status, 200);
    assert.match(sentCodes[0], /^\d{5}$/);
    const verify = () => request(app)
      .post("/api/auth/verify")
      .set("X-Forwarded-For", ip)
      .send({ email, code: wrongCode(sentCodes[0]) });
    const first = await verify();
    assert.equal(first.status, 400);
    assert.equal(first.body.attempt, 1);
    assert.equal(first.body.attemptsLeft, OTP_MAX_TRIES - 1);
    assert.equal(first.body.maxAttempts, OTP_MAX_TRIES);
    assert.equal(first.body.error, `Код не тот. Попыток осталось: ${OTP_MAX_TRIES - 1} из ${OTP_MAX_TRIES}`);
    for (let i = 2; i < OTP_MAX_TRIES; i += 1) {
      const next = await verify();
      assert.equal(next.body.attempt, i);
      assert.equal(next.body.attemptsLeft, OTP_MAX_TRIES - i);
    }
    const last = await verify();
    assert.equal(last.status, 410);
    assert.equal(last.body.error, "Слишком много попыток. Запросите новый код.");
    assert.equal(last.body.attemptsLeft, undefined);
  });

  it("send-code returns which send this is in the window", async () => {
    const first = await sendCode();
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true, retryAfterSec: 30, sendNumber: 1 });
    await redis.del(otpCooldownKey(email));
    const second = await sendCode();
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { ok: true, retryAfterSec: 30, sendNumber: 2 });
  });
});
