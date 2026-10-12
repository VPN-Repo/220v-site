import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
const { redis, isMockRedis } = await import("../redis.mjs");
const { createAuthRouter } = await import("../auth/routes.mjs");
const { requireSession } = await import("../auth/session.mjs");
const { putOtp } = await import("../auth/otp.mjs");
const { hashCode } = await import("../auth/crypto.mjs");
const { getCredential, saveInitialPassword, saveLoginSession } = await import("../auth/password.mjs");
const { otpKey, passwordOtpKey } = await import("../auth/keys.mjs");

const userUuid = "b6810e6c-8a69-42b1-b298-8b07d8378987";
const email = "password-case@gmail.com";
const firstPassword = "long-password-first1";
const secondPassword = "long-password-second2";
let emailedCode = "";
let emailedPurpose = "";
let failMail = false;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((req, _res, next) => {
  req.log = { info() {}, warn() {}, debug() {}, error() {} };
  next();
});
app.use(createAuthRouter({
  mailer: {
    sendOtpEmail: async ({ code, purpose }) => {
      if (failMail) return { ok: false, error: "test_failure" };
      emailedCode = code;
      emailedPurpose = purpose || "login";
      return { ok: true };
    },
  },
  loadUserProfile: async (userEmail) => {
    if (userEmail === "profile-failure@gmail.com") throw Object.assign(new Error("RMW down"), { status: 502 });
    return { user: { userUuid } };
  },
  extractUserUuid: (profile) => profile.user?.userUuid || null,
}));
app.get("/api/test/me", requireSession, (req, res) => res.json({ email: req.session.email }));

const cookieValue = (res, name) => {
  const cookie = res.headers["set-cookie"].find((item) => item.startsWith(`${name}=`));
  return decodeURIComponent(cookie.split(";")[0].slice(name.length + 1));
};
const csrfFrom = (res) => cookieValue(res, "v220_csrf");
const sidFrom = (res) => cookieValue(res, "v220_sid");

describe("password authentication", () => {
  before(async () => { await redis.flushdb(); });
  after(async () => { await redis.quit(); });

  it("reports no password for an unknown account and keeps code login unchanged", async () => {
    const method = await request(app).post("/api/auth/method").send({ email: "nobody@gmail.com" });
    assert.equal(method.status, 200);
    assert.equal(method.body.hasPassword, false);
    assert.equal((await request(app).post("/api/auth/method").send({ email: "bad" })).status, 400);
    assert.equal((await request(app).post("/api/auth/login-password")
      .send({ email: "nobody@gmail.com", password: "whatever1" })).status, 401);

    const agent = request.agent(app);
    await putOtp("plain-code@gmail.com", hashCode("12345"), "owner");
    const login = await agent.post("/api/auth/verify").send({ email: "plain-code@gmail.com", code: "12345" });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(await redis.exists(otpKey("plain-code@gmail.com")), 0);
    assert.equal((await agent.get("/api/test/me")).status, 200);
    assert.equal(await getCredential("plain-code@gmail.com"), null);
  });

  it("rejects a weak new password on the code step without consuming the code", async () => {
    await putOtp(email, hashCode("54321"), "owner");
    const weak = await request(app).post("/api/auth/verify")
      .send({ email, code: "54321", newPassword: "onlyletters" });
    assert.equal(weak.status, 400);
    assert.match(weak.body.error, /букву и одну цифру/);
    assert.equal(await redis.exists(otpKey(email)), 1);
    assert.equal(await getCredential(email), null);
    await redis.del(otpKey(email));
  });

  it("sets and changes password while revoking other sessions", async () => {
    const oldAgent = request.agent(app);
    await putOtp(email, hashCode("11111"), "owner");
    const oldLogin = await oldAgent.post("/api/auth/verify").send({ email, code: "11111" });
    assert.equal(oldLogin.status, 200, JSON.stringify(oldLogin.body));

    const current = request.agent(app);
    await putOtp(email, hashCode("22222"), "owner");
    const firstLogin = await current.post("/api/auth/verify")
      .send({ email, code: "22222", newPassword: firstPassword });
    assert.equal(firstLogin.status, 200, JSON.stringify(firstLogin.body));
    assert.equal((await getCredential(email)).version, 1);
    assert.equal((await oldAgent.get("/api/test/me")).status, 401);
    assert.equal((await current.get("/api/test/me")).status, 200);
    assert.equal((await request(app).post("/api/auth/method").send({ email })).body.hasPassword, true);

    await putOtp(email, hashCode("23456"), "owner", 1);
    const again = await request(app).post("/api/auth/verify")
      .send({ email, code: "23456", newPassword: secondPassword });
    assert.equal(again.status, 409);
    await redis.del(otpKey(email));

    const another = request.agent(app);
    assert.equal((await another.post("/api/auth/login-password")
      .send({ email, password: firstPassword })).status, 200);
    assert.equal((await another.get("/api/test/me")).status, 200);
    assert.equal((await request(app).post("/api/auth/login-password")
      .send({ email, password: "wrong-password1" })).status, 401);

    const csrf = csrfFrom(firstLogin);
    const sid = sidFrom(firstLogin);
    await putOtp(email, hashCode("33333"), "owner", 1);
    const sent = await current.post("/api/auth/password/send-code").set("X-CSRF-Token", csrf).send({});
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(emailedPurpose, "password_change");
    const cooldown = await current.post("/api/auth/password/send-code").set("X-CSRF-Token", csrf).send({});
    assert.equal(cooldown.status, 429);
    assert.ok(cooldown.body.retryAfterSec > 0);
    const passwordCodeTtl = await redis.ttl(passwordOtpKey(sid));
    assert.equal((await current.post("/api/auth/password/change")
      .send({ code: emailedCode, newPassword: secondPassword })).status, 403);
    assert.equal((await request(app).post("/api/auth/verify")
      .send({ email, code: emailedCode === "33333" ? "33334" : emailedCode })).status, 400);
    const wrongCode = emailedCode === "00000" ? "00001" : "00000";
    assert.equal((await current.post("/api/auth/password/change")
      .set("X-CSRF-Token", csrf).send({ code: wrongCode, newPassword: secondPassword })).status, 400);
    assert.ok((await redis.ttl(passwordOtpKey(sid))) <= passwordCodeTtl);
    const changed = await current.post("/api/auth/password/change")
      .set("X-CSRF-Token", csrf).send({ code: emailedCode, newPassword: secondPassword });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.hasPassword, true);
    assert.equal((await getCredential(email)).version, 2);
    assert.equal((await current.get("/api/test/me")).status, 200);
    assert.equal((await another.get("/api/test/me")).status, 401);
    assert.equal(await saveLoginSession(email, userUuid, 1, "late-old-login",
      { email, userUuid, authVersion: 1 }, 60), "version_changed");
    assert.equal((await request(app).post("/api/auth/verify")
      .send({ email, code: "33333" })).status, 409);
    assert.equal(await redis.exists(otpKey(email)), 0);
    assert.equal((await request(app).post("/api/auth/login-password")
      .send({ email, password: firstPassword })).status, 401);
    assert.equal((await request(app).post("/api/auth/login-password")
      .send({ email, password: secondPassword })).status, 200);
  });

  it("does not store a password when the external profile fails", async () => {
    const failedEmail = "profile-failure@gmail.com";
    await putOtp(failedEmail, hashCode("44444"), "owner");
    const result = await request(app).post("/api/auth/verify")
      .send({ email: failedEmail, code: "44444", newPassword: firstPassword });
    assert.equal(result.status, 502);
    assert.equal(await getCredential(failedEmail), null);
    assert.equal(await redis.exists(otpKey(failedEmail)), 1);
  });

  it("clears an unsent password-change code and its cooldown", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login-password")
      .send({ email, password: secondPassword });
    assert.equal(login.status, 200);
    const sid = sidFrom(login);
    failMail = true;
    try {
      const result = await agent.post("/api/auth/password/send-code")
        .set("X-CSRF-Token", csrfFrom(login)).send({});
      assert.equal(result.status, 502);
      assert.equal(await redis.exists(passwordOtpKey(sid)), 0);
    } finally { failMail = false; }
    assert.equal((await agent.post("/api/auth/password/send-code")
      .set("X-CSRF-Token", csrfFrom(login)).send({})).status, 200);
  });

  it("refuses a concurrent initial credential overwrite", { skip: isMockRedis }, async () => {
    const keyEmail = "concurrent@gmail.com";
    const credential = { userUuid, version: 1, salt: "a".repeat(32), hash: "b".repeat(128) };
    const session = { email: keyEmail, userUuid, authVersion: 1 };
    const results = await Promise.all([
      saveInitialPassword(keyEmail, "initial-a", credential, session, 60),
      saveInitialPassword(keyEmail, "initial-b", credential, session, 60),
    ]);
    assert.equal(results.filter((item) => item === "ok").length, 1);
  });
});
