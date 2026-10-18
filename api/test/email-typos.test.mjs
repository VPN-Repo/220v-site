import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "silent";

const { redis } = await import("../redis.mjs");
const { createAuthRouter } = await import("../auth/routes.mjs");
const { hasLocalPartTypo } = await import("../auth/emailTypos.mjs");

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

describe("hasLocalPartTypo", () => {
  it("flags junk that only comes from typos", () => {
    for (const local of ["ivan-", "ivan.", "ivan_", "ivan--", ".ivan", "iv..an"]) {
      assert.equal(hasLocalPartTypo(local), true, local);
    }
  });

  it("accepts ordinary local parts", () => {
    for (const local of ["ivan", "ivan.petrov", "ivan-petrov", "ivan_petrov", "i", "ivan2000", "a.b.c"]) {
      assert.equal(hasLocalPartTypo(local), false, local);
    }
  });
});

describe("POST /api/auth/send-code local-part typos", () => {
  it("rejects a trailing hyphen before sending any code", async () => {
    const res = await sendCode("ivan-@gmail.com");
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Проверьте адрес: похоже, в нём опечатка");
    assert.deepEqual(sent, []);
  });

  it("rejects double dots and a trailing dot", async () => {
    for (const email of ["iv..an@mail.ru", "ivan.@yandex.ru", "ivan_@bk.ru"]) {
      const res = await sendCode(email);
      assert.equal(res.status, 400, email);
      assert.match(res.body.error, /опечатка/);
    }
    assert.deepEqual(sent, []);
  });

  it("still sends a code to a valid address", async () => {
    const res = await sendCode("ivan-petrov@gmail.com");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(sent, ["ivan-petrov@gmail.com"]);
  });
});
