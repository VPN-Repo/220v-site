import { describe, it, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

const uploadsDir = mkdtempSync(join(tmpdir(), "chatwoot-uploads-"));

process.env.NODE_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.RMW_API_URL = "https://rmw.test";
process.env.RMW_API_KEY = "test-key";
process.env.TALKME_API_TOKEN = "test-talkme-token";
process.env.CHATWOOT_BASE_URL = "https://chat.example.test/";
process.env.CHATWOOT_INBOX_IDENTIFIER = "inbox-abc";
process.env.CHATWOOT_HMAC_TOKEN = "test-hmac-token";
process.env.SUPPORT_CHAT_UPLOADS_DIR = uploadsDir;

const { app } = await import("../index.mjs");
const { redis } = await import("../redis.mjs");
const { saveSession } = await import("../auth/session.mjs");
const { base64url } = await import("../auth/crypto.mjs");
const { chatwootContactKey } = await import("../auth/keys.mjs");
const { SESSION_COOKIE, CSRF_COOKIE } = await import("../config.mjs");

const TEST_EMAIL = "chat-user@example.com";
const TEST_UUID = "b6810e6c-8a69-42b1-b298-8b07d8378987";
const INBOX_PREFIX = "https://chat.example.test/public/api/v1/inboxes/inbox-abc";

const originalFetch = globalThis.fetch;

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
  return agent;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Мок Chatwoot Client API. `conversations` — то, что вернёт список диалогов;
 * все вызовы складываются в `calls`.
 */
let calls = [];
function installChatwootMock({ conversations = [], messages = [], contactsStatus = 200 } = {}) {
  calls = [];
  let nextConversationId = 900;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const method = options.method || "GET";
    let body = options.body;
    if (typeof body === "string") body = JSON.parse(body);
    calls.push({ href, method, body });

    if (!href.startsWith(INBOX_PREFIX)) {
      return json({ error: "unexpected host" }, 500);
    }
    const path = href.slice(INBOX_PREFIX.length);

    if (method === "POST" && path === "/contacts") {
      if (contactsStatus !== 200) return json({ error: "nope" }, contactsStatus);
      return json({ id: 1, source_id: "src-1", pubsub_token: "pubsub-1", email: body.email });
    }
    if (method === "PATCH" && path === "/contacts/src-1") return json({ id: 1 });
    if (method === "GET" && path === "/contacts/src-1/conversations") return json(conversations);
    if (method === "POST" && path === "/contacts/src-1/conversations") {
      const created = { id: nextConversationId++, status: "open" };
      conversations.push(created);
      return json(created);
    }
    const msgMatch = path.match(/^\/contacts\/src-1\/conversations\/(\d+)\/messages$/);
    if (msgMatch && method === "GET") return json(messages);
    if (msgMatch && method === "POST") {
      return json({ id: 5000, content: body instanceof FormData ? body.get("content") : body.content });
    }
    if (/\/update_last_seen$/.test(path)) return json({});
    return json({ error: "unexpected path" }, 404);
  };
}

async function seedState(state) {
  await redis.set(
    chatwootContactKey(TEST_UUID),
    JSON.stringify({ sourceId: "src-1", pubsubToken: "pubsub-1", conversationId: null, ...state }),
  );
}

describe("chatwoot provider", () => {
  before(async () => {
    await redis.flushdb();
  });

  beforeEach(async () => {
    await redis.flushdb();
    installChatwootMock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    rmSync(uploadsDir, { recursive: true, force: true });
    await redis.quit();
  });

  it("GET /api/chat/provider reports chatwoot when env is set", async () => {
    const res = await request(app).get("/api/chat/provider");
    assert.equal(res.status, 200);
    assert.equal(res.body.provider, "chatwoot");
  });

  it("client-id requires a session and reports the provider", async () => {
    const anon = await request(app).post("/api/talkme/client-id").send({});
    assert.equal(anon.status, 401);

    const agent = await createSessionAgent();
    const res = await agent.post("/api/talkme/client-id").send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.provider, "chatwoot");
    assert.match(res.body.clientId, /^[0-9a-f]{32}$/);
    assert.equal(calls.length, 0, "Talk-Me и Chatwoot не вызываются");
  });

  it("first send creates the contact with identifier_hash and custom attributes, then a conversation", async () => {
    const agent = await createSessionAgent();
    const res = await agent.post("/api/talkme/send").send({
      text: "Не работает VPN",
      name: "220v",
      custom: {
        Traffic: "25Gb/100Gb",
        Devices: "2/5",
        Tariff: "Pro",
        Expiration_date: "01.12.2026",
        "bad key": "ignored",
      },
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.messageId, 5000);

    const contactCall = calls.find((c) => c.method === "POST" && c.href.endsWith("/contacts"));
    assert.ok(contactCall, "контакт создан");
    assert.equal(contactCall.body.identifier, TEST_UUID);
    assert.equal(
      contactCall.body.identifier_hash,
      createHmac("sha256", "test-hmac-token").update(TEST_UUID).digest("hex"),
    );
    assert.equal(contactCall.body.email, TEST_EMAIL);
    assert.deepEqual(contactCall.body.custom_attributes, {
      site: "220v",
      tariff: "Pro",
      devices: "2/5",
      traffic: "25Gb/100Gb",
      expire_at: "01.12.2026",
    });

    assert.ok(
      calls.some((c) => c.method === "POST" && c.href.endsWith("/contacts/src-1/conversations")),
      "диалог создан",
    );
    const msgCall = calls.find((c) => c.method === "POST" && c.href.endsWith("/conversations/900/messages"));
    assert.deepEqual(msgCall.body, { content: "Не работает VPN" });

    const stored = JSON.parse(await redis.get(chatwootContactKey(TEST_UUID)));
    assert.equal(stored.sourceId, "src-1");
    assert.equal(stored.conversationId, 900);
  });

  it("second send reuses the contact and the open conversation", async () => {
    installChatwootMock({ conversations: [{ id: 7, status: "resolved" }, { id: 12, status: "open" }] });
    await seedState({ conversationId: 12 });

    const agent = await createSessionAgent();
    const res = await agent.post("/api/talkme/send").send({ text: "ещё вопрос" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.ok(!calls.some((c) => c.method === "POST" && c.href.endsWith("/contacts")), "контакт не пересоздаётся");
    assert.ok(
      !calls.some((c) => c.method === "POST" && c.href.endsWith("/contacts/src-1/conversations")),
      "новый диалог не создаётся",
    );
    assert.ok(calls.some((c) => c.method === "POST" && c.href.endsWith("/conversations/12/messages")));
  });

  it("send creates a new conversation when the last one is resolved", async () => {
    installChatwootMock({ conversations: [{ id: 12, status: "resolved" }] });
    await seedState({ conversationId: 12 });

    const agent = await createSessionAgent();
    const res = await agent.post("/api/talkme/send").send({ text: "снова сломалось" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.ok(calls.some((c) => c.method === "POST" && c.href.endsWith("/contacts/src-1/conversations")));
    assert.ok(calls.some((c) => c.method === "POST" && c.href.endsWith("/conversations/900/messages")));
    const stored = JSON.parse(await redis.get(chatwootContactKey(TEST_UUID)));
    assert.equal(stored.conversationId, 900);
  });

  it("messages maps Chatwoot messages to the UI shape", async () => {
    installChatwootMock({
      conversations: [{ id: 12, status: "open" }],
      messages: [
        { id: 3, content: "Здравствуйте!", message_type: 1, created_at: 1760000100, sender: { available_name: "Анна" } },
        { id: 2, content: "Помогите", message_type: 0, created_at: 1760000000, sender: { name: TEST_EMAIL } },
        { id: 4, content: "Conversation was resolved", message_type: 2, created_at: 1760000200 },
        { id: 5, content: "внутренняя заметка", message_type: 1, private: true, created_at: 1760000300 },
        {
          id: 6,
          content: "",
          message_type: "outgoing",
          created_at: 1760000400,
          sender: { name: "Анна" },
          attachments: [
            { file_type: "image", data_url: "https://chat.example.test/rails/active_storage/blobs/x/screen.png" },
          ],
        },
      ],
    });
    await seedState({});

    const agent = await createSessionAgent();
    const res = await agent.post("/api/talkme/messages").send({ limit: 200 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.hasVisitor, true);
    assert.equal(res.body.conversationId, 12);
    assert.deepEqual(res.body.messages, [
      {
        id: 2,
        text: "Помогите",
        sender: "client",
        operatorName: null,
        dateTime: new Date(1760000000 * 1000).toISOString(),
        status: "",
      },
      {
        id: 3,
        text: "Здравствуйте!",
        sender: "operator",
        operatorName: "Анна",
        dateTime: new Date(1760000100 * 1000).toISOString(),
        status: "",
      },
      {
        id: 6,
        text: "",
        sender: "operator",
        operatorName: "Анна",
        dateTime: new Date(1760000400 * 1000).toISOString(),
        status: "",
        attachments: [
          {
            url: "https://chat.example.test/rails/active_storage/blobs/x/screen.png",
            fileName: "screen.png",
            kind: "image",
          },
        ],
      },
    ]);
  });

  it("messages returns empty history without creating a contact", async () => {
    const agent = await createSessionAgent();
    const res = await agent.post("/api/talkme/messages").send({ limit: 10 });
    assert.equal(res.status, 200);
    assert.equal(res.body.hasVisitor, false);
    assert.deepEqual(res.body.messages, []);
    assert.equal(calls.length, 0);
  });

  it("upstream 401 is not passed through as a site-session 401", async () => {
    installChatwootMock({ contactsStatus: 401 });
    const agent = await createSessionAgent();
    const res = await agent.post("/api/talkme/send").send({ text: "hi" });
    assert.equal(res.status, 502);
  });

  it("forwards an uploaded attachment to Chatwoot as multipart", async () => {
    installChatwootMock({ conversations: [{ id: 12, status: "open" }] });
    await seedState({ conversationId: 12 });
    const agent = await createSessionAgent();

    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    // Ссылка на вложение валидна только для того же хоста, что и запрос отправки.
    const upload = await agent
      .post("/api/support/chat-attachment")
      .set("Host", "220v.test")
      .attach("file", png, { filename: "screen.png", contentType: "image/png" });
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    assert.equal(upload.body.kind, "image");

    const res = await agent.post("/api/talkme/send").set("Host", "220v.test").send({
      text: "скрин",
      attachmentUrl: upload.body.url,
      attachmentName: "screen.png",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const msgCall = calls.find((c) => c.method === "POST" && c.href.endsWith("/conversations/12/messages"));
    assert.ok(msgCall.body instanceof FormData, "multipart");
    assert.equal(msgCall.body.get("content"), "скрин");
    const file = msgCall.body.get("attachments[]");
    assert.equal(file.name, "screen.png");
    assert.equal(file.type, "image/png");
    assert.equal(file.size, png.length);
  });

  it("rejects attachment urls outside the upload directory and keeps upload validation", async () => {
    const agent = await createSessionAgent();
    const host = "127.0.0.1";
    const res = await agent
      .post("/api/talkme/send")
      .set("Host", host)
      .send({ attachmentUrl: `http://${host}/api/support/chat-attachment/..%2F..%2Fetc%2Fpasswd` });
    assert.equal(res.status, 400);

    const svg = await agent
      .post("/api/support/chat-attachment")
      .attach("file", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), {
        filename: "evil.svg",
        contentType: "image/svg+xml",
      });
    assert.equal(svg.status, 400);
  });

  it("operator-list and typing degrade to neutral values", async () => {
    const agent = await createSessionAgent();
    const { body: idBody } = await agent.post("/api/talkme/client-id").send({});

    const ops = await agent.post("/api/talkme/operator-list").send({});
    assert.deepEqual(ops.body, { onlineCount: null, supported: false });

    const typing = await agent.post("/api/talkme/operator-typing-status").send({ clientId: idBody.clientId });
    assert.equal(typing.body.typing, false);

    const foreign = await agent.post("/api/talkme/operator-typing-status").send({ clientId: "f".repeat(32) });
    assert.equal(foreign.status, 403);
  });

  it("dialog-status maps the latest conversation status", async () => {
    installChatwootMock({ conversations: [{ id: 12, status: "resolved" }, { id: 15, status: "open" }] });
    await seedState({ conversationId: 12 });
    const agent = await createSessionAgent();
    const res = await agent.post("/api/talkme/dialog-status").send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.statusLabel, "Диалог открыт");
    const stored = JSON.parse(await redis.get(chatwootContactKey(TEST_UUID)));
    assert.equal(stored.conversationId, 15);
  });
});
