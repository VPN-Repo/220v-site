import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "silent";

const { redis } = await import("../redis.mjs");
const { createAuthRouter } = await import("../auth/routes.mjs");

const sent = [];
const quietLog = { info() {}, warn() {}, debug() {}, error() {} };
const app = express();
app.set("trust proxy", 1);
let clientIp = 0;
const nextIp = () => `203.0.113.${(clientIp++ % 250) + 1}`;
app.use(express.json());
app.use((req, _res, next) => { req.log = quietLog; next(); });
app.use(createAuthRouter({
  mailer: {
    async sendOtpEmail({ email }) {
      sent.push(email);
      return { ok: true, provider: "primary", failover: false };
    },
  },
  loadUserProfile: async () => ({}),
  extractUserUuid: () => null,
}));

const sendCode = (email) =>
  request(app).post("/api/auth/send-code").set("X-Forwarded-For", nextIp()).send({ email });

beforeEach(async () => {
  await redis.flushdb();
  sent.length = 0;
});

after(async () => {
  await redis.quit();
});

// Owner decision: typos are only hinted in the UI, the server never rejects them.
describe("POST /api/auth/send-code does not reject typo-looking addresses", () => {
  it("sends a code to local parts with a trailing separator, double or leading dots", async () => {
    const emails = ["ivan-@gmail.com", "iv..an@mail.ru", "ivan.@yandex.ru", ".ivan@bk.ru", "ivan_@list.ru"];
    for (const email of emails) {
      const res = await sendCode(email);
      assert.equal(res.status, 200, email);
      assert.equal(res.body.ok, true, email);
    }
    assert.deepEqual(sent, emails);
  });

  it("keeps the existing domain allowlist", async () => {
    const res = await sendCode("ivan@mail.ry");
    assert.equal(res.status, 400);
    assert.match(res.body.error, /домен не поддерживается/);
    assert.deepEqual(sent, []);
  });
});
