/**
 * Chatwoot (self-hosted) как провайдер чата поддержки для кастомного UI `/chat`.
 *
 * Работает через Client API инбокса типа «API»:
 *   `${CHATWOOT_BASE_URL}/public/api/v1/inboxes/${CHATWOOT_INBOX_IDENTIFIER}/...`
 *
 * Маршруты и формы ответов те же, что у `talkme-routes.mjs` (`/api/talkme/*`),
 * поэтому фронт не знает, какой провайдер за ними стоит. Браузер с Chatwoot
 * напрямую не общается: все вызовы идут с сервера.
 *
 * Связка «пользователь 220v → контакт Chatwoot» хранится в Redis по UUID
 * пользователя (`source_id` контакта и текущий `conversation_id`), так что с
 * любого устройства пользователь попадает в один и тот же диалог.
 */
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { clientError } from "./http/errors.mjs";
import { fetchWithTimeout } from "./http/fetchWithTimeout.mjs";
import { formatTimeoutMessage, isTimeoutError, publicMessageFromErr } from "./http/userMessages.mjs";
import {
  chatUploadLimiter,
  talkmeIpLimiter,
  talkmeSessionLimiter,
} from "./http/rateLimit.mjs";
import { requireSession } from "./auth/session.mjs";
import { chatwootContactKey } from "./auth/keys.mjs";
import { redis } from "./redis.mjs";
import {
  isAllowedAttachmentUrl,
  registerSupportChatAttachmentRoutes,
  resolveUploadedAttachmentPath,
} from "./support-chat-uploads.mjs";

const SITE_LABEL = "220v";
const UPLOAD_TIMEOUT_MS = 120_000;

function chatwootConfig() {
  return {
    baseUrl: (process.env.CHATWOOT_BASE_URL || "").trim().replace(/\/+$/, ""),
    inboxIdentifier: (process.env.CHATWOOT_INBOX_IDENTIFIER || "").trim(),
    hmacToken: (process.env.CHATWOOT_HMAC_TOKEN || "").trim(),
  };
}

/** Chatwoot включается, только когда заданы и адрес, и идентификатор инбокса. */
export function isChatwootConfigured() {
  const { baseUrl, inboxIdentifier } = chatwootConfig();
  return Boolean(baseUrl && inboxIdentifier);
}

export function getChatProvider() {
  return isChatwootConfigured() ? "chatwoot" : "talkme";
}

/** HMAC-SHA256(identifier) токеном инбокса — `identifier_hash` для identity validation. */
export function chatwootIdentifierHash(identifier, hmacToken = chatwootConfig().hmacToken) {
  if (!hmacToken) return "";
  return createHmac("sha256", hmacToken).update(String(identifier)).digest("hex");
}

/** Непрозрачный id для фронта: сам `source_id` наружу не отдаём. */
function publicClientId(userUuid) {
  return createHash("sha256").update(`220v:chatwoot:${userUuid}`).digest("hex").slice(0, 32);
}

// ── HTTP к Chatwoot ──

function upstreamError(status, data) {
  const detail =
    (typeof data?.error === "string" && data.error) ||
    (typeof data?.message === "string" && data.message) ||
    "";
  const err = new Error(
    `Чат поддержки временно недоступен (${status}${detail ? `: ${detail}` : ""})`,
  );
  // Наружу никогда не отдаём 401/403/404 апстрима: 401 фронт принял бы за
  // истёкшую сессию сайта и разлогинил пользователя.
  err.statusCode = 502;
  err.upstreamStatus = status;
  return err;
}

function networkError(netErr) {
  if (isTimeoutError(netErr)) {
    const err = new Error(formatTimeoutMessage(netErr.timeoutMs, "чат поддержки"));
    err.isTimeout = true;
    err.timeoutMs = netErr.timeoutMs;
    err.statusCode = 504;
    return err;
  }
  const err = new Error(
    `Ошибка сети при обращении к чату: ${netErr?.message || String(netErr || "неизвестная ошибка")}`,
  );
  err.statusCode = 502;
  return err;
}

async function chatwootRequest(path, { method = "GET", json, form, timeoutMs } = {}) {
  const { baseUrl, inboxIdentifier } = chatwootConfig();
  const url = `${baseUrl}/public/api/v1/inboxes/${encodeURIComponent(inboxIdentifier)}${path}`;
  const headers = { Accept: "application/json" };
  let body;
  if (form) {
    body = form;
  } else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }

  // Идемпотентные GET повторяем один раз при сетевом сбое.
  const retries = method === "GET" ? 1 : 0;
  for (let attempt = 0; ; attempt += 1) {
    let r;
    try {
      r = await fetchWithTimeout(url, { method, headers, body }, timeoutMs);
    } catch (netErr) {
      if (attempt < retries) {
        await new Promise((rs) => setTimeout(rs, 250));
        continue;
      }
      throw networkError(netErr);
    }

    const text = await r.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (r.ok) {
          const err = new Error("Некорректный ответ от сервера чата");
          err.statusCode = 502;
          throw err;
        }
      }
    }
    if (!r.ok) throw upstreamError(r.status, data);
    return data;
  }
}

function routeError(err, fallback = "Ошибка чата") {
  const message = publicMessageFromErr(err, fallback, { context: "чат поддержки" });
  const status = err?.statusCode || (isTimeoutError(err) ? 504 : 500);
  return { message, status };
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.payload)) return data.payload;
  return [];
}

// ── Состояние пользователя в Redis ──

async function loadState(userUuid) {
  const raw = await redis.get(chatwootContactKey(userUuid));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.sourceId === "string" && parsed.sourceId ? parsed : null;
  } catch {
    return null;
  }
}

async function saveState(userUuid, state) {
  await redis.set(chatwootContactKey(userUuid), JSON.stringify(state));
}

async function clearState(userUuid) {
  await redis.del(chatwootContactKey(userUuid));
}

// ── Карточка контакта ──

const CUSTOM_FIELD_MAP = {
  Tariff: "tariff",
  Devices: "devices",
  Traffic: "traffic",
  Expiration_date: "expire_at",
};

/**
 * Поля из `buildTalkMeCustomFields` на фронте (`Traffic`, `Devices`, `Tariff`,
 * `Expiration_date`) → `custom_attributes` контакта Chatwoot.
 */
export function buildChatwootCustomAttributes(custom) {
  const out = { site: SITE_LABEL };
  if (!custom || typeof custom !== "object") return out;
  for (const [from, to] of Object.entries(CUSTOM_FIELD_MAP)) {
    const value = custom[from];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) out[to] = trimmed.slice(0, 256);
  }
  return out;
}

function attrsHash(attrs) {
  return createHash("sha256").update(JSON.stringify(attrs)).digest("hex").slice(0, 16);
}

function contactPayload(req, customAttributes) {
  const { userUuid, email } = req.session;
  const payload = {
    identifier: userUuid,
    email,
    name: email,
    custom_attributes: customAttributes,
  };
  const hash = chatwootIdentifierHash(userUuid);
  if (hash) payload.identifier_hash = hash;
  return payload;
}

const contactCreationInFlight = new Map();
let warnedNoHmac = false;

/** Возвращает состояние с контактом, при необходимости создавая контакт в Chatwoot. */
async function ensureContact(req, customAttributes) {
  const { userUuid } = req.session;
  const existing = await loadState(userUuid);
  if (existing) return existing;

  // Параллельные запросы одного пользователя не должны плодить контакты.
  const pending = contactCreationInFlight.get(userUuid);
  if (pending) return pending;

  const promise = (async () => {
    if (!chatwootConfig().hmacToken && !warnedNoHmac) {
      warnedNoHmac = true;
      req.log?.warn("CHATWOOT_HMAC_TOKEN is not set: contacts are created without identity validation");
    }
    const contact = await chatwootRequest("/contacts", {
      method: "POST",
      json: contactPayload(req, customAttributes),
    });
    const sourceId = typeof contact?.source_id === "string" ? contact.source_id : "";
    if (!sourceId) {
      const err = new Error("Чат поддержки не вернул идентификатор контакта");
      err.statusCode = 502;
      throw err;
    }
    const state = {
      sourceId,
      pubsubToken: typeof contact?.pubsub_token === "string" ? contact.pubsub_token : null,
      conversationId: null,
      attrsHash: attrsHash(customAttributes),
    };
    await saveState(userUuid, state);
    return state;
  })();

  contactCreationInFlight.set(userUuid, promise);
  try {
    return await promise;
  } finally {
    contactCreationInFlight.delete(userUuid);
  }
}

/** Best-effort обновление карточки, только если атрибуты изменились. */
async function syncContactAttributes(req, state, customAttributes) {
  const hash = attrsHash(customAttributes);
  if (state.attrsHash === hash) return state;
  try {
    await chatwootRequest(`/contacts/${encodeURIComponent(state.sourceId)}`, {
      method: "PATCH",
      json: contactPayload(req, customAttributes),
    });
    const next = { ...state, attrsHash: hash };
    await saveState(req.session.userUuid, next);
    return next;
  } catch (err) {
    req.log?.warn({ err: { message: err?.message } }, "chatwoot contact update failed");
    return state;
  }
}

// ── Диалоги ──

function conversationsPath(sourceId) {
  return `/contacts/${encodeURIComponent(sourceId)}/conversations`;
}

async function listConversations(sourceId) {
  return asArray(await chatwootRequest(conversationsPath(sourceId)))
    .filter((c) => c && Number.isFinite(Number(c.id)));
}

function newest(conversations) {
  return [...conversations].sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

/** Открытым считаем всё, что не `resolved` (open / pending / snoozed). */
export function pickReusableConversation(conversations) {
  return newest(conversations.filter((c) => c.status !== "resolved"));
}

const STATUS_LABELS = {
  open: "Диалог открыт",
  pending: "Ожидает оператора",
  snoozed: "Диалог отложен",
  resolved: "Диалог завершён",
};

// ── Сообщения ──

const MESSAGE_TYPES = ["incoming", "outgoing", "activity", "template"];

function normalizeMessageType(value) {
  if (typeof value === "number") return MESSAGE_TYPES[value] || "unknown";
  return typeof value === "string" ? value : "unknown";
}

function toIsoDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Chatwoot отдаёт unix-время в секундах.
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  return "";
}

function fileNameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
    return name || "Вложение";
  } catch {
    return "Вложение";
  }
}

function mapAttachment(a) {
  const url = typeof a?.data_url === "string" ? a.data_url : "";
  if (!/^https?:\/\//i.test(url)) return null;
  const fileName = fileNameFromUrl(url);
  const ext = (typeof a.extension === "string" && a.extension) || extname(fileName).slice(1);
  let kind = "file";
  if (a.file_type === "image") kind = "image";
  else if (a.file_type === "video") kind = "video";
  else if (String(ext).toLowerCase() === "zip") kind = "zip";
  return { url, fileName, kind };
}

/** Сообщение Chatwoot → форма `ChatMessage` из `Chat.tsx`. */
export function mapChatwootMessage(m) {
  if (!m || m.private === true) return null;
  const type = normalizeMessageType(m.message_type);
  if (type !== "incoming" && type !== "outgoing" && type !== "template") return null;
  const id = Number(m.id);
  if (!Number.isFinite(id)) return null;

  const isClient = type === "incoming";
  const attachments = (Array.isArray(m.attachments) ? m.attachments : [])
    .map(mapAttachment)
    .filter(Boolean);
  const text = typeof m.content === "string" ? m.content : "";
  if (!text && attachments.length === 0) return null;

  const message = {
    id,
    text,
    sender: isClient ? "client" : "operator",
    operatorName: isClient
      ? null
      : m.sender?.available_name || m.sender?.name || null,
    dateTime: toIsoDate(m.created_at),
    status: typeof m.status === "string" ? m.status : "",
  };
  if (attachments.length > 0) message.attachments = attachments;
  return message;
}

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".zip": "application/zip",
};

function safeAttachmentName(name, fallbackPath) {
  const cleaned = basename(String(name || "").replace(/[\\/]+/g, "/")).trim().slice(0, 120);
  return cleaned || basename(fallbackPath);
}

// ── Маршруты ──

export function registerChatwootRoutes(app) {
  const chatProtected = [talkmeIpLimiter, talkmeSessionLimiter, ...requireSession];
  const uploadProtected = [chatUploadLimiter, talkmeIpLimiter, ...requireSession];

  registerSupportChatAttachmentRoutes(app, uploadProtected);

  function assertSessionClientId(req, res, clientId) {
    const trimmed = typeof clientId === "string" ? clientId.trim() : "";
    if (!trimmed) {
      clientError(res, 400, "Требуется clientId");
      return null;
    }
    if (trimmed !== publicClientId(req.session.userUuid)) {
      clientError(res, 403, "Недопустимый clientId");
      return null;
    }
    return trimmed;
  }

  /** Контакт, удалённый в Chatwoot, отвечает 404 — забываем его, чтобы создать заново. */
  async function forgetIfGone(req, err) {
    if (err?.upstreamStatus === 404) {
      await clearState(req.session.userUuid);
      return true;
    }
    return false;
  }

  app.post("/api/talkme/client-id", ...chatProtected, (req, res) => {
    return res.json({ clientId: publicClientId(req.session.userUuid), provider: "chatwoot" });
  });

  app.post("/api/talkme/client-search", ...chatProtected, async (req, res) => {
    try {
      const state = await loadState(req.session.userUuid);
      const clientId = publicClientId(req.session.userUuid);
      if (!state) return res.json({ clients: [], selected: null });
      const client = { clientId, conversationId: state.conversationId ?? null };
      return res.json({ clients: [client], selected: client });
    } catch (err) {
      const { message, status } = routeError(err);
      return res.status(status).json({ error: message });
    }
  });

  app.post("/api/talkme/messages", ...chatProtected, async (req, res) => {
    const empty = (hasVisitor) =>
      res.json({ messages: [], count: 0, searchId: null, conversationId: null, hasVisitor });
    try {
      const { userUuid } = req.session;
      let state = await loadState(userUuid);
      if (!state) return empty(false);

      let conversationId = state.conversationId;
      if (!conversationId) {
        const latest = newest(await listConversations(state.sourceId));
        if (!latest) return empty(true);
        conversationId = Number(latest.id);
        state = { ...state, conversationId };
        await saveState(userUuid, state);
      }

      const data = await chatwootRequest(
        `${conversationsPath(state.sourceId)}/${encodeURIComponent(conversationId)}/messages`,
      );
      const limit = Math.min(Math.max(Number(req.body?.limit) || 100, 1), 500);
      const messages = asArray(data)
        .map(mapChatwootMessage)
        .filter(Boolean)
        .sort((a, b) => a.id - b.id)
        .slice(-limit);

      return res.json({
        messages,
        count: messages.length,
        searchId: null,
        conversationId,
        hasVisitor: true,
      });
    } catch (err) {
      if (await forgetIfGone(req, err)) return empty(false);
      const { message, status } = routeError(err);
      return res.status(status).json({ error: message });
    }
  });

  async function sendMessage(req, { text, filePath, fileName }) {
    const customAttributes = buildChatwootCustomAttributes(req.body?.custom);
    let state = await ensureContact(req, customAttributes);
    state = await syncContactAttributes(req, state, customAttributes);

    const conversations = await listConversations(state.sourceId);
    let conversation = pickReusableConversation(conversations);
    if (!conversation) {
      conversation = await chatwootRequest(conversationsPath(state.sourceId), {
        method: "POST",
        json: {},
      });
    }
    const conversationId = Number(conversation?.id);
    if (!Number.isFinite(conversationId)) {
      const err = new Error("Чат поддержки не вернул идентификатор диалога");
      err.statusCode = 502;
      throw err;
    }
    if (state.conversationId !== conversationId) {
      state = { ...state, conversationId };
      await saveState(req.session.userUuid, state);
    }

    const messagesPath = `${conversationsPath(state.sourceId)}/${conversationId}/messages`;
    if (filePath) {
      const buffer = await readFile(filePath);
      const type = MIME_BY_EXT[extname(filePath).toLowerCase()] || "application/octet-stream";
      const form = new FormData();
      if (text) form.append("content", text);
      form.append("attachments[]", new Blob([buffer], { type }), fileName);
      return chatwootRequest(messagesPath, { method: "POST", form, timeoutMs: UPLOAD_TIMEOUT_MS });
    }
    return chatwootRequest(messagesPath, { method: "POST", json: { content: text } });
  }

  app.post("/api/talkme/send", ...chatProtected, async (req, res) => {
    try {
      const { text, attachmentUrl, attachmentName } = req.body || {};
      const trimmedText = typeof text === "string" ? text.trim() : "";
      const trimmedAttachmentUrl = typeof attachmentUrl === "string" ? attachmentUrl.trim() : "";

      if (!trimmedText && !trimmedAttachmentUrl) {
        return res.status(400).json({ error: "Требуется текст или файл" });
      }

      let filePath = null;
      if (trimmedAttachmentUrl) {
        filePath = isAllowedAttachmentUrl(trimmedAttachmentUrl, req)
          ? resolveUploadedAttachmentPath(trimmedAttachmentUrl)
          : null;
        if (!filePath) {
          return res
            .status(400)
            .json({ error: "Ссылка на вложение должна указывать на загруженный файл" });
        }
      }
      const fileName = filePath ? safeAttachmentName(attachmentName, filePath) : null;

      let message;
      try {
        message = await sendMessage(req, { text: trimmedText, filePath, fileName });
      } catch (err) {
        if (err?.code === "ENOENT") {
          return res.status(400).json({ error: "Загруженный файл не найден, прикрепите его заново" });
        }
        // Контакт удалили в Chatwoot — создаём заново и повторяем один раз.
        if (!(await forgetIfGone(req, err))) throw err;
        message = await sendMessage(req, { text: trimmedText, filePath, fileName });
      }

      const numericId = Number(message?.id);
      return res.json({
        messageId: Number.isFinite(numericId) && numericId > 0 ? numericId : null,
        clientId: publicClientId(req.session.userUuid),
      });
    } catch (err) {
      const { message, status } = routeError(err);
      return res.status(status).json({ error: message });
    }
  });

  /**
   * `readed` → `update_last_seen` текущего диалога (Chatwoot не хранит статус
   * отдельных сообщений со стороны клиента). `delivered` — no-op.
   */
  app.post("/api/talkme/message-status", ...chatProtected, async (req, res) => {
    try {
      const { messageId, status } = req.body || {};
      const mid = Number(messageId);
      if (!Number.isInteger(mid) || mid <= 0) {
        return res.status(400).json({ error: "Некорректный идентификатор сообщения" });
      }
      if (status !== "delivered" && status !== "readed") {
        return res.status(400).json({ error: "Некорректный статус сообщения" });
      }
      const state = await loadState(req.session.userUuid);
      if (status === "delivered" || !state?.conversationId) {
        return res.json({ success: true, noop: true });
      }
      await chatwootRequest(
        `${conversationsPath(state.sourceId)}/${state.conversationId}/update_last_seen`,
        { method: "POST" },
      );
      return res.json({ success: true });
    } catch (err) {
      const { message, status } = routeError(err);
      return res.status(status).json({ error: message });
    }
  });

  /** Статус последнего диалога; заодно переключает сохранённый диалог на самый свежий. */
  app.post("/api/talkme/dialog-status", ...chatProtected, async (req, res) => {
    try {
      const { userUuid } = req.session;
      const state = await loadState(userUuid);
      if (!state) return res.json({ statusLabel: null, raw: null });
      const latest = newest(await listConversations(state.sourceId));
      if (!latest) return res.json({ statusLabel: null, raw: null });
      const conversationId = Number(latest.id);
      if (state.conversationId !== conversationId) {
        await saveState(userUuid, { ...state, conversationId });
      }
      return res.json({
        statusLabel: STATUS_LABELS[latest.status] || null,
        raw: { conversationId, status: latest.status ?? null },
      });
    } catch (err) {
      if (await forgetIfGone(req, err)) return res.json({ statusLabel: null, raw: null });
      const { message, status } = routeError(err);
      return res.status(status).json({ error: message });
    }
  });

  /**
   * Набор оператора в Chatwoot приходит только по ActionCable-вебсокету, а
   * этот провайдер работает поллингом — честно отвечаем «не поддерживается».
   */
  app.post("/api/talkme/operator-typing-status", ...chatProtected, (req, res) => {
    if (!assertSessionClientId(req, res, req.body?.clientId)) return;
    return res.json({ typing: false, operatorLogin: null, secondsLeft: 0, supported: false });
  });

  app.post("/api/talkme/send-typing", ...chatProtected, (_req, res) => {
    return res
      .status(501)
      .json({ error: "Имитация набора оператором не поддерживается для Chatwoot" });
  });

  /** У Client API нет списка операторов онлайн — фронт прячет бейдж по `supported: false`. */
  app.post("/api/talkme/operator-list", ...chatProtected, (_req, res) => {
    return res.json({ onlineCount: null, supported: false });
  });
}
