import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
delete process.env.CHATWOOT_HMAC_TOKEN;

const { app } = await import("../index.mjs");
const { redis } = await import("../redis.mjs");
const { saveSession } = await import("../auth/session.mjs");
const { SESSION_COOKIE, CSRF_COOKIE } = await import("../config.mjs");

const userUuid = "b6810e6c-8a69-42b1-b298-8b07d8378987";
const email = "user@example.com";
const cookie = `${SESSION_COOKIE}=chat-session; ${CSRF_COOKIE}=test-csrf`;

beforeEach(async () => {
  delete process.env.CHATWOOT_HMAC_TOKEN;
  await redis.flushdb();
  await saveSession("chat-session", { email, userUuid, csrf: "test-csrf", expAt: Date.now() + 3600_000 });
});

after(async () => {
  delete process.env.CHATWOOT_HMAC_TOKEN;
  await redis.quit();
});

const identity = () => request(app).get("/api/chat/identity").set("Cookie", cookie);

describe("GET /api/chat/identity", () => {
  it("requires a session", async () => {
    const res = await request(app).get("/api/chat/identity");
    assert.equal(res.status, 401);
    assert.equal(res.body.identifier_hash, undefined);
  });

  it("rejects an unknown session", async () => {
    const res = await request(app)
      .get("/api/chat/identity")
      .set("Cookie", `${SESSION_COOKIE}=missing; ${CSRF_COOKIE}=test-csrf`);
    assert.equal(res.status, 401);
  });

  it("returns an HMAC-SHA256 hex of the user UUID when the token is set", async () => {
    process.env.CHATWOOT_HMAC_TOKEN = "test-hmac-token";
    const res = await identity();
    assert.equal(res.status, 200);
    const expected = createHmac("sha256", "test-hmac-token").update(userUuid).digest("hex");
    assert.deepEqual(res.body, { identifier: userUuid, identifier_hash: expected, email, name: email });
    assert.match(res.body.identifier_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(res.body).includes("test-hmac-token"));
    assert.equal(res.headers["cache-control"], "no-store");
  });

  it("returns identifier_hash null without the token", async () => {
    const res = await identity();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { identifier: userUuid, identifier_hash: null, email, name: email });
  });
});
