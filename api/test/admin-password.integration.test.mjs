import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.ADMIN_REDIS_TOKEN = "admin-test-token";
const { redis } = await import("../redis.mjs");
const { createAuthRouter } = await import("../auth/routes.mjs");
const { requireSession } = await import("../auth/session.mjs");
const { putOtp } = await import("../auth/otp.mjs");
const { hashCode } = await import("../auth/crypto.mjs");
const { getCredential } = await import("../auth/password.mjs");

const userUuid = "c2a1f6a4-7d1e-4f55-9a6b-2f0c1d9e8b71";
const email = "support-case@gmail.com";
const missingEmail = "nobody-here@gmail.com";
const profileCalls = [];
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((req, _res, next) => {
  req.log = { info() {}, warn() {}, debug() {}, error() {} };
  next();
});
app.use(createAuthRouter({
  mailer: { sendOtpEmail: async () => ({ ok: true }) },
  loadUserProfile: async (userEmail, _req, refUuid, options) => {
    profileCalls.push({ userEmail, refUuid, options });
    return userEmail === missingEmail
      ? { exists: false, user: { userUuid: "d3b2a7b5-8e2f-4a66-8b7c-3a1d2e0f9c82" } }
      : { exists: true, user: { userUuid } };
  },
  extractUserUuid: (profile) => profile.user?.userUuid || null,
}));
app.get("/api/test/me", requireSession, (req, res) => res.json({ email: req.session.email }));

const setPassword = (body, token = "admin-test-token") => request(app)
  .post("/api/admin/set-password").set("X-Admin-Token", token).send(body);

describe("support-assigned password", () => {
  before(async () => { await redis.flushdb(); });
  after(async () => { await redis.quit(); });

  it("rejects requests without a valid admin token", async () => {
    assert.equal((await setPassword({ email, password: "support-pass1" }, "wrong")).status, 401);
    assert.equal(await getCredential(email), null);
  });

  it("validates the password strength", async () => {
    assert.equal((await setPassword({ email, password: "short" })).status, 400);
    assert.equal((await setPassword({ email, password: "onlyletters" })).status, 400);
  });

  it("refuses accounts that do not exist", async () => {
    assert.equal((await setPassword({ email: missingEmail, password: "support-pass1" })).status, 404);
    assert.equal(await getCredential(missingEmail), null);
  });

  it("sets a password that works for login and revokes older sessions", async () => {
    const oldAgent = request.agent(app);
    await putOtp(email, hashCode("33333"), "owner");
    assert.equal((await oldAgent.post("/api/auth/verify").send({ email, code: "33333" })).status, 200);
    assert.equal((await oldAgent.get("/api/test/me")).status, 200);

    profileCalls.length = 0;
    const first = await setPassword({ email: ` ${email.toUpperCase()} `, password: "support-pass1" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.version, 1);
    assert.deepEqual(profileCalls, [{ userEmail: email, refUuid: undefined, options: { enrich: false } }]);
    assert.equal((await getCredential(email)).userUuid, userUuid);
    assert.equal((await oldAgent.get("/api/test/me")).status, 401);
    assert.equal((await request(app).post("/api/auth/method").send({ email })).body.hasPassword, true);

    const agent = request.agent(app);
    assert.equal((await agent.post("/api/auth/login-password").send({ email, password: "support-pass1" })).status, 200);
    assert.equal((await agent.get("/api/test/me")).status, 200);

    const second = await setPassword({ email, password: "support-pass2" });
    assert.equal(second.body.version, 2);
    assert.equal((await agent.get("/api/test/me")).status, 401);
    assert.equal((await request(app).post("/api/auth/login-password")
      .send({ email, password: "support-pass1" })).status, 401);
    assert.equal((await request(app).post("/api/auth/login-password")
      .send({ email, password: "support-pass2" })).status, 200);
  });
});
