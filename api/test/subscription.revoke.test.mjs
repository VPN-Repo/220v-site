import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.RMW_API_URL = "https://rmw.test";
process.env.RMW_API_KEY = "test-key";
delete process.env.REMNAWAVE_TOKEN;

const { app } = await import("../index.mjs");
const { redis } = await import("../redis.mjs");
const { saveSession } = await import("../auth/session.mjs");
const { subscriptionRevokeUserLimiter } = await import("../http/rateLimit.mjs");
const { SESSION_COOKIE, CSRF_COOKIE } = await import("../config.mjs");

const uuid = "b6810e6c-8a69-42b1-b298-8b07d8378987";
const otherUuid = "a6810e6c-8a69-42b1-b298-8b07d8378987";
const OLD_URL = "https://sub.test/old-link";
const NEW_URL = "https://sub.test/new-link";
const originalFetch = globalThis.fetch;

let calls;
let revokeStatus;
let revokeThrows;
let revoked;
let sessionStatus;
let profileUuid;

function revoke({ csrfHeader = "test-csrf", cookie = true } = {}) {
  const req = request(app).post("/api/me/subscription/revoke");
  if (cookie) req.set("Cookie", [`${SESSION_COOKIE}=revoke-test`, `${CSRF_COOKIE}=test-csrf`]);
  if (csrfHeader) req.set("X-CSRF-Token", csrfHeader);
  return req.send({});
}

beforeEach(async () => {
  await redis.flushdb();
  await subscriptionRevokeUserLimiter.resetKey(uuid);
  await saveSession("revoke-test", { userUuid: uuid, email: "revoke@example.com", csrf: "test-csrf" });
  calls = [];
  revokeStatus = 200;
  revokeThrows = null;
  revoked = false;
  sessionStatus = 200;
  profileUuid = uuid;
  globalThis.fetch = async (url, options = {}) => {
    const { pathname } = new URL(url);
    calls.push({ path: pathname, method: options.method, headers: options.headers, body: options.body });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (pathname === `/v1/users/${uuid}/revoke`) {
      if (revokeThrows) throw revokeThrows;
      if (revokeStatus === 200) revoked = true;
      return json(revokeStatus === 200 ? { ok: true } : { error: "remnawave revoke failed" }, revokeStatus);
    }
    if (pathname === "/v1/auth/session") {
      if (sessionStatus !== 200) return json({ error: "internal error" }, sessionStatus);
      return json({
        exists: true,
        user: {
          userUuid: profileUuid,
          tariff: "1month",
          plan: "1 Месяц",
          subscriptionUrl: revoked ? NEW_URL : OLD_URL,
        },
      });
    }
    if (pathname.startsWith("/v1/hwid/devices/")) return json({ devices: [{ hwid: "abc" }], total: 1 });
    throw new Error(`Unexpected request: ${pathname}`);
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
after(async () => {
  await redis.quit();
});

const revokeCalls = () => calls.filter((c) => c.path === `/v1/users/${uuid}/revoke`);

describe("POST /api/me/subscription/revoke", () => {
  it("requires a session", async () => {
    const res = await revoke({ cookie: false });
    assert.equal(res.status, 401);
    assert.equal(revokeCalls().length, 0);
  });

  it("requires a matching CSRF token", async () => {
    const missing = await revoke({ csrfHeader: "" });
    assert.equal(missing.status, 403);
    const wrong = await revoke({ csrfHeader: "other-csrf" });
    assert.equal(wrong.status, 403);
    assert.equal(revokeCalls().length, 0);
  });

  it("revokes the session user in RMW and returns the fresh link", async () => {
    const res = await revoke();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.subscriptionUrl, NEW_URL);
    assert.equal(res.body.user.subscriptionUrl, NEW_URL);
    assert.equal(res.body.user.currentDevices, 1);

    const [call] = revokeCalls();
    assert.equal(call.method, "POST");
    assert.equal(call.headers["X-Api-Key"], "test-key");
    // the profile is reloaded only after the revoke succeeded
    const order = calls.map((c) => c.path);
    assert.ok(order.indexOf(`/v1/users/${uuid}/revoke`) < order.indexOf("/v1/auth/session"));
  });

  it("does not trust a uuid sent by the client", async () => {
    const res = await request(app)
      .post("/api/me/subscription/revoke")
      .set("Cookie", [`${SESSION_COOKIE}=revoke-test`, `${CSRF_COOKIE}=test-csrf`])
      .set("X-CSRF-Token", "test-csrf")
      .send({ uuid: otherUuid });
    assert.equal(res.status, 200);
    assert.equal(revokeCalls().length, 1);
    assert.ok(!calls.some((c) => c.path.includes(otherUuid)));
  });

  it("allows 3 revokes per hour per user, then answers 429 with the wait time", async () => {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await revoke()).status, 200);
    }
    const limited = await revoke();
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, "rate_limited");
    assert.match(limited.body.error, /не чаще 3 раз в час/);
    assert.match(limited.body.error, /Повторите через \d+ мин\./);
    assert.ok(limited.body.retryAfterSec > 0);
    assert.equal(revokeCalls().length, 3);
  });

  it("maps an RMW failure to a friendly message without leaking details", async () => {
    revokeStatus = 502;
    const res = await revoke();
    assert.equal(res.status, 502);
    assert.match(res.body.error, /Не удалось обновить ссылку подключения/);
    assert.doesNotMatch(JSON.stringify(res.body), /remnawave|RMW|rmw\.test/i);
    assert.ok(!calls.some((c) => c.path === "/v1/auth/session"));
  });

  it("maps an unknown user to 404", async () => {
    revokeStatus = 404;
    const res = await revoke();
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Подписка не найдена/);
  });

  it("maps a network error to 502 and a timeout to 504", async () => {
    revokeThrows = new Error("connect ECONNREFUSED 10.0.0.1:443");
    const network = await revoke();
    assert.equal(network.status, 502);
    assert.doesNotMatch(network.body.error, /ECONNREFUSED|10\.0\.0\.1/);

    revokeThrows = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const timeout = await revoke();
    assert.equal(timeout.status, 504);
    assert.match(timeout.body.error, /Превышено время ожидания/);
  });

  it("still reports success when the new link cannot be loaded", async () => {
    sessionStatus = 500;
    const res = await revoke();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.subscriptionUrl, null);
    assert.match(res.body.message, /Ссылка обновлена/);
  });

  it("never returns a profile that belongs to another user", async () => {
    profileUuid = otherUuid;
    const res = await revoke();
    assert.equal(res.status, 200);
    assert.equal(res.body.user, null);
    assert.equal(res.body.subscriptionUrl, null);
  });
});
