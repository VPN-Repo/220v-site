import { describe, it, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.TALKME_API_TOKEN = "test-talkme-token";
process.env.TALKME_SITE_HOSTS = "220v.shop";
process.env.RMW_API_URL = "https://rmw.test";
process.env.RMW_API_KEY = "test-key";

const { app } = await import("../index.mjs");
const { redis } = await import("../redis.mjs");
const { saveSession } = await import("../auth/session.mjs");
const { base64url } = await import("../auth/crypto.mjs");
const { SESSION_COOKIE, CSRF_COOKIE } = await import("../config.mjs");

const TEST_EMAIL = "chat-user@example.com";
const TEST_UUID = "b6810e6c-8a69-42b1-b298-8b07d8378987";

const originalFetch = globalThis.fetch;

function syntheticClientIdFromEmail(email) {
  const normalized = `220v:${String(email || "").trim().toLowerCase()}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

async function createSessionAgent() {
  const sid = base64url(randomBytes(32));
  const csrf = base64url(randomBytes(32));
  await saveSession(sid, {
    userUuid: TEST_UUID,
    email: TEST_EMAIL,
    csrf,
    expAt: Date.now() + 3600_000,
  });

  const agent = request.agent(app);
  agent.set("Cookie", [`${SESSION_COOKIE}=${sid}`, `${CSRF_COOKIE}=${csrf}`]);
  agent.set("X-CSRF-Token", csrf);

  return {
    agent,
    clientId: syntheticClientIdFromEmail(TEST_EMAIL),
  };
}

/** Посетитель Talk-Me, заведённый виджетом на конкретном сайте. */
function widgetClient({ searchId, host, lastActivity }) {
  return {
    clientId: `widget-${searchId}`,
    searchId,
    email: TEST_EMAIL,
    firstVisit: { page: { url: `https://${host}/dashboard` } },
    lastVisit: { lastDateTimeUTC: lastActivity, page: { url: `https://${host}/dashboard` } },
  };
}

/** Тело последнего запроса истории — чтобы проверить, какого клиента прочитали. */
let lastMessageListBody = null;

function installTalkMeFetchMock({ clients } = {}) {
  lastMessageListBody = null;

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    const body = options.body ? JSON.parse(options.body) : {};

    if (path.includes("/chat/client/search")) {
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            clients: clients ?? [
              { clientId: syntheticClientIdFromEmail(body.email), searchId: 42 },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (path.includes("/chat/message/getClientMessageList")) {
      lastMessageListBody = body;
      return new Response(
        JSON.stringify({ success: true, result: { items: [], count: 0 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (path.includes("/chat/operator/getList")) {
      return new Response(
        JSON.stringify({ success: true, result: { operators: [] } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ success: false, error: { descr: "unexpected path" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("talkme security", () => {
  before(async () => {
    await redis.flushdb();
  });

  beforeEach(async () => {
    await redis.flushdb();
    installTalkMeFetchMock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await redis.quit();
  });

  it("POST /api/talkme/client-id without cookie returns 401", async () => {
    const res = await request(app).post("/api/talkme/client-id").send({});
    assert.equal(res.status, 401);
  });

  it("POST /api/talkme/client-id with cookie but without CSRF returns 403", async () => {
    const sid = base64url(randomBytes(32));
    const csrf = base64url(randomBytes(32));
    await saveSession(sid, {
      userUuid: TEST_UUID,
      email: TEST_EMAIL,
      csrf,
      expAt: Date.now() + 3600_000,
    });

    const res = await request(app)
      .post("/api/talkme/client-id")
      .set("Cookie", [`${SESSION_COOKIE}=${sid}`, `${CSRF_COOKIE}=${csrf}`])
      .send({});

    assert.equal(res.status, 403);
  });

  it("POST /api/talkme/client-id with valid session returns clientId", async () => {
    const { agent, clientId } = await createSessionAgent();
    const res = await agent.post("/api/talkme/client-id").send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.clientId, clientId);
  });

  it("POST /api/talkme/messages with foreign clientId returns 403", async () => {
    const { agent, clientId } = await createSessionAgent();
    const foreignClientId = clientId.replace(/^./, "f");

    const res = await agent.post("/api/talkme/messages").send({
      clientId: foreignClientId,
      limit: 10,
    });

    assert.equal(res.status, 403);
  });

  it("POST /api/talkme/messages reads the visitor of our own site, not a sibling project's", async () => {
    installTalkMeFetchMock({
      clients: [
        // Кабинет Talk-Me общий на несколько проектов: первым в ответе идёт
        // посетитель чужого сайта, и раньше именно его историю и читали.
        widgetClient({ searchId: 550783, host: "letovps.ru", lastActivity: "2026-08-22 08:37:27" }),
        widgetClient({ searchId: 349705, host: "220v.shop", lastActivity: "2026-08-26 12:04:27" }),
      ],
    });

    const { agent } = await createSessionAgent();
    const res = await agent.post("/api/talkme/messages").send({ limit: 10 });

    assert.equal(res.status, 200);
    assert.equal(res.body.hasVisitor, true);
    assert.equal(res.body.searchId, 349705);
    assert.deepEqual(lastMessageListBody.client, { searchId: 349705 });
  });

  it("POST /api/talkme/messages picks the most recently active visitor of our site", async () => {
    installTalkMeFetchMock({
      clients: [
        widgetClient({ searchId: 111, host: "220v.shop", lastActivity: "2026-05-30 15:39:51" }),
        widgetClient({ searchId: 222, host: "220v.shop", lastActivity: "2026-08-26 12:04:27" }),
      ],
    });

    const { agent } = await createSessionAgent();
    const res = await agent.post("/api/talkme/messages").send({ limit: 10 });

    assert.equal(res.status, 200);
    assert.equal(res.body.searchId, 222);
  });

  it("POST /api/talkme/messages returns empty history when only foreign visitors exist", async () => {
    installTalkMeFetchMock({
      clients: [
        widgetClient({ searchId: 550783, host: "letovps.ru", lastActivity: "2026-08-22 08:37:27" }),
      ],
    });

    const { agent } = await createSessionAgent();
    const res = await agent.post("/api/talkme/messages").send({ limit: 10 });

    assert.equal(res.status, 200);
    assert.equal(res.body.hasVisitor, false);
    assert.deepEqual(res.body.messages, []);
    assert.equal(lastMessageListBody, null, "историю чужого посетителя запрашивать нельзя");
  });

  it("POST /api/talkme/messages with a foreign searchId returns 403", async () => {
    installTalkMeFetchMock({
      clients: [
        widgetClient({ searchId: 349705, host: "220v.shop", lastActivity: "2026-08-26 12:04:27" }),
      ],
    });

    const { agent } = await createSessionAgent();
    const res = await agent.post("/api/talkme/messages").send({ searchId: 550783, limit: 10 });

    assert.equal(res.status, 403);
  });

  it("POST /api/talkme/messages reads the REST-created visitor by searchId", async () => {
    // У записи, созданной нашей же REST-отправкой, нет firstVisit.page.url —
    // опознаём её по детерминированному clientId.
    installTalkMeFetchMock({
      clients: [{ clientId: syntheticClientIdFromEmail(TEST_EMAIL), searchId: 311084 }],
    });

    const { agent } = await createSessionAgent();
    const res = await agent.post("/api/talkme/messages").send({ limit: 10 });

    assert.equal(res.status, 200);
    assert.equal(res.body.searchId, 311084);
    assert.deepEqual(lastMessageListBody.client, { searchId: 311084 });
  });

  it("POST /api/support/chat-attachment rejects svg", async () => {
    const { agent } = await createSessionAgent();

    const res = await agent
      .post("/api/support/chat-attachment")
      .attach("file", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), {
        filename: "evil.svg",
        contentType: "image/svg+xml",
      });

    assert.equal(res.status, 400);
  });
});
