import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, resolve } from "node:path";
import express from "express";
import multer from "multer";
import { clientError } from "./http/errors.mjs";
import { fetchWithTimeout } from "./http/fetchWithTimeout.mjs";
import { formatTimeoutMessage, isTimeoutError, publicMessageFromErr } from "./http/userMessages.mjs";
import {
  chatUploadLimiter,
  talkmeIpLimiter,
  talkmeSessionLimiter,
} from "./http/rateLimit.mjs";
import { requireSession } from "./auth/session.mjs";
import { isProd } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPPORT_CHAT_UPLOADS_DIR = resolve(
  process.env.SUPPORT_CHAT_UPLOADS_DIR?.trim() || resolve(__dirname, "uploads", "support-chat"),
);
const SUPPORT_CHAT_MAX_FILE_SIZE_MB = Number(process.env.SUPPORT_CHAT_MAX_FILE_SIZE_MB || "50");
const SUPPORT_CHAT_MAX_FILE_SIZE =
  Number.isFinite(SUPPORT_CHAT_MAX_FILE_SIZE_MB) && SUPPORT_CHAT_MAX_FILE_SIZE_MB > 0
    ? SUPPORT_CHAT_MAX_FILE_SIZE_MB * 1024 * 1024
    : 50 * 1024 * 1024;
const CHAT_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const CHAT_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"]);
const CHAT_ZIP_EXTENSIONS = new Set([".zip"]);
const CHAT_ALLOWED_EXTENSIONS = new Set([
  ...CHAT_IMAGE_EXTENSIONS,
  ...CHAT_VIDEO_EXTENSIONS,
  ...CHAT_ZIP_EXTENSIONS,
]);
const CHAT_ALLOWED_MIME_PREFIXES = ["image/", "video/"];
const CHAT_ALLOWED_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "multipart/x-zip",
  "application/octet-stream",
]);
mkdirSync(SUPPORT_CHAT_UPLOADS_DIR, { recursive: true });

function getChatFileExtension(file) {
  return extname(file?.originalname || "").toLowerCase();
}

function sanitizeChatFileBaseName(name) {
  return (name || "file")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "file";
}

function getChatAttachmentKind({ ext, mimeType }) {
  if (CHAT_IMAGE_EXTENSIONS.has(ext) || mimeType.startsWith("image/")) return "image";
  if (CHAT_VIDEO_EXTENSIONS.has(ext) || mimeType.startsWith("video/")) return "video";
  return "zip";
}

function isAllowedChatFile(file) {
  const ext = getChatFileExtension(file);
  if (ext === ".svg") return false;
  if (!CHAT_ALLOWED_EXTENSIONS.has(ext)) return false;
  const mimeType = String(file?.mimetype || "").toLowerCase();
  if (mimeType === "image/svg+xml") return false;
  if (!mimeType) return true;
  if (CHAT_ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return true;
  if (CHAT_ZIP_EXTENSIONS.has(ext) && CHAT_ALLOWED_MIME_TYPES.has(mimeType)) return true;
  return false;
}

function buildPublicUrl(req, path) {
  const protoHeader = String(req.headers["x-forwarded-proto"] || req.protocol || "http");
  const proto = protoHeader.split(",")[0].trim() || "http";
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").trim();
  if (!host) return path;
  return `${proto}://${host}${path}`;
}

const supportChatUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, SUPPORT_CHAT_UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = getChatFileExtension(file);
      const base = sanitizeChatFileBaseName(file.originalname.replace(/\.[^.]+$/, ""));
      cb(null, `${Date.now()}-${randomUUID()}-${base}${ext}`);
    },
  }),
  limits: { fileSize: SUPPORT_CHAT_MAX_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!isAllowedChatFile(file)) {
      cb(new Error("Поддерживаются только изображения, видео и ZIP-файлы."));
      return;
    }
    cb(null, true);
  },
});

export function registerTalkMeRoutes(app) {
  app.use(
    "/api/support/chat-attachment",
    (_req, res, next) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      next();
    },
    express.static(SUPPORT_CHAT_UPLOADS_DIR),
  );

  const talkmeProtected = [talkmeIpLimiter, talkmeSessionLimiter, ...requireSession];
  const uploadProtected = [chatUploadLimiter, talkmeIpLimiter, ...requireSession];

// ── Talk-Me REST API proxy (for /chat) ──

const TALKME_API_BASE = "https://lcab.talk-me.ru/json/v1.0";

/**
 * Детерминированный 32-hex clientId от email.
 *
 * Вычисляется на бэкенде, потому что `crypto.subtle` во фронте недоступен в
 * non-secure контекстах (HTTP-развёртывания), и прямой вызов валит отправку.
 *
 * Talk-Me REST `/chat/message/sendToOperator` принимает произвольный
 * 32-символьный `client.id` и создаёт по нему запись клиента на лету — это
 * единственный надёжный способ, когда widget-путь `setClientInfo` сломан
 * (адблок, сбой загрузки `support.js` и т.п.). Email, переданный в payload
 * рядом с id, сохраняется на стороне Talk-Me и становится искомым ключом для
 * последующих `client-search`.
 */
function syntheticClientIdFromEmail(email) {
  const normalized = `220v:${String(email || "").trim().toLowerCase()}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function getTalkMeIdentity(req) {
  const email = req.session.email;
  return {
    email,
    clientId: syntheticClientIdFromEmail(email),
  };
}

function normalizeSiteHost(host) {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/:\d+$/, "");
}

function siteHostFromUrl(url) {
  try {
    return normalizeSiteHost(new URL(String(url)).hostname);
  } catch {
    return "";
  }
}

const CONFIGURED_TALKME_SITE_HOSTS = (() => {
  const hosts = new Set();
  for (const host of (process.env.TALKME_SITE_HOSTS || "").split(",")) {
    const normalized = normalizeSiteHost(host);
    if (normalized) hosts.add(normalized);
  }
  const publicHost = siteHostFromUrl(process.env.PUBLIC_SITE_URL || "");
  if (publicHost) hosts.add(publicHost);
  return hosts;
})();

/**
 * Хосты, чьи посетители Talk-Me считаются «нашими».
 *
 * Кабинет Talk-Me общий на несколько проектов, поэтому `client/search` по email
 * отдаёт и записи соседних сайтов. Читать историю из них нельзя: в чат 220v
 * утечёт переписка другого проекта, а у пользователя, который завёл там
 * визитёра позже, наша история просто исчезнет.
 */
function ownSiteHosts(req) {
  if (isProd) return CONFIGURED_TALKME_SITE_HOSTS;

  // В dev/staging приложение живёт на произвольном хосте (localhost, 192.168.x.x),
  // и посетители заведены под ним — иначе история локально всегда пустая.
  const requestHost = normalizeSiteHost(
    String(req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0],
  );
  if (!requestHost) return CONFIGURED_TALKME_SITE_HOSTS;
  return new Set([...CONFIGURED_TALKME_SITE_HOSTS, requestHost]);
}

/** Talk-Me отдаёт время как `YYYY-MM-DD HH:mm:ss` в UTC. */
function talkMeDateToMs(value) {
  if (typeof value !== "string" || !value.trim()) return 0;
  const parsed = Date.parse(`${value.trim().replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapTalkMeClient(c) {
  const hosts = [
    siteHostFromUrl(c?.firstVisit?.page?.url),
    siteHostFromUrl(c?.lastVisit?.page?.url),
  ].filter(Boolean);

  return {
    clientId: c.clientId || "",
    searchId: c.searchId ?? null,
    name: c.name || "",
    email: c.email || "",
    siteHosts: [...new Set(hosts)],
    lastActivityAt: Math.max(
      talkMeDateToMs(c?.lastVisit?.lastDateTimeUTC),
      talkMeDateToMs(c?.lastVisit?.dateTimeUTC),
      talkMeDateToMs(c?.firstVisit?.dateTimeUTC),
    ),
  };
}

async function findTalkMeClientsForEmail(email) {
  const result = await talkmeRequest("/chat/client/search", {
    email: String(email || "").trim().toLowerCase(),
  });
  return (result?.clients || []).map(mapTalkMeClient);
}

function isOwnTalkMeClient(client, syntheticClientId, hosts) {
  // Запись, созданную нашим же REST-путём, узнаём по детерминированному id:
  // у неё нет `firstVisit.page.url`, так что по хосту её не опознать.
  if (syntheticClientId && client.clientId === syntheticClientId) return true;
  return client.siteHosts.some((host) => hosts.has(host));
}

/**
 * Выбирает посетителя Talk-Me, чью историю показываем текущей сессии.
 *
 * У одного email легко оказывается несколько «наших» записей (виджет на разных
 * устройствах плюс запись от REST-отправки), а отвечает оператор всегда в самой
 * свежей — её и берём.
 */
async function resolveTalkMeVisitor(req) {
  const { email, clientId: syntheticClientId } = getTalkMeIdentity(req);
  const hosts = ownSiteHosts(req);
  const all = await findTalkMeClientsForEmail(email);
  const clients = all.filter((c) => isOwnTalkMeClient(c, syntheticClientId, hosts));

  if (all.length > 0 && clients.length === 0) {
    console.warn(
      `[talkme] у сессии есть ${all.length} посетителей Talk-Me, но ни один не относится к [${[...hosts].join(", ")}] — проверьте PUBLIC_SITE_URL/TALKME_SITE_HOSTS`,
    );
  }

  const selected =
    clients
      .filter((c) => typeof c.searchId === "number" && c.searchId > 0)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0] || null;

  return { clients, selected };
}

/**
 * Разрешает клиента для запросов, читающих диалог.
 *
 * Всегда возвращает `searchId`: `getClientMessageList` с `client.id` отвечает
 * «Посетитель не найден» для любого офлайн-посетителя, поэтому id-путь для
 * чтения непригоден. `client === null` означает «посетителя ещё нет» — это не
 * ошибка, а пустая история до первого сообщения.
 */
async function resolveClientLookup(req, res, body) {
  const { clientId: expectedClientId } = getTalkMeIdentity(req);

  const rawClientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  if (rawClientId && rawClientId !== expectedClientId) {
    clientError(res, 403, "Недопустимый clientId");
    return null;
  }

  const { clients, selected } = await resolveTalkMeVisitor(req);

  const hasSearchId =
    typeof body?.searchId === "number" && Number.isFinite(body.searchId) && body.searchId > 0;
  if (hasSearchId && !clients.some((c) => c.searchId === body.searchId)) {
    clientError(res, 403, "Недопустимый searchId");
    return null;
  }

  const searchId = hasSearchId ? body.searchId : (selected?.searchId ?? null);
  return { searchId, client: searchId ? { searchId } : null };
}

function assertSessionClientId(req, res, clientId) {
  const trimmed = typeof clientId === "string" ? clientId.trim() : "";
  if (!trimmed) {
    clientError(res, 400, "Требуется clientId");
    return null;
  }
  if (trimmed !== getTalkMeIdentity(req).clientId) {
    clientError(res, 403, "Недопустимый clientId");
    return null;
  }
  return trimmed;
}

function isAllowedAttachmentUrl(url, req) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (!parsed.pathname.includes("/support/chat-attachment/")) return false;
    const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
      .split(",")[0]
      .trim();
    return !host || parsed.host === host;
  } catch {
    return false;
  }
}

function talkmeToken() {
  return process.env.TALKME_API_TOKEN?.trim() || process.env.VITE_SUPPORT_CHAT_API_KEY?.trim() || "";
}

function talkmeNetworkError(netErr) {
  if (isTimeoutError(netErr)) {
    const err = new Error(formatTimeoutMessage(netErr.timeoutMs, "чат поддержки"));
    err.isTimeout = true;
    err.timeoutMs = netErr.timeoutMs;
    err.statusCode = 504;
    return err;
  }

  const detail = netErr?.message || String(netErr || "неизвестная ошибка");
  const err = new Error(`Ошибка сети при обращении к чату: ${detail}`);
  err.statusCode = 502;
  return err;
}

function talkmeRouteError(err, fallback = "Ошибка чата") {
  const message = publicMessageFromErr(err, fallback, { context: "чат поддержки" });
  const status = err?.statusCode || (isTimeoutError(err) ? 504 : 500);
  return { message, status };
}

async function talkmeRequest(path, body, { retries = 1 } = {}) {
  const token = talkmeToken();
  if (!token) throw new Error("TALKME_API_TOKEN is not configured");

  let lastNetworkErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let r;
    try {
      r = await fetchWithTimeout(`${TALKME_API_BASE}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Token": token,
        },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      // Talk-Me иногда «дропает» соединение (TLS reset / connection refused) —
      // 1 ретрай через короткую паузу обычно достаточно.
      lastNetworkErr = netErr;
      if (attempt < retries) {
        await new Promise((rs) => setTimeout(rs, 250));
        continue;
      }
      throw talkmeNetworkError(netErr);
    }

    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      const err = new Error("Некорректный ответ от сервера чата");
      err.statusCode = 502;
      throw err;
    }

    if (!r.ok || data.success === false) {
      const errMsg = data?.error?.descr || `Ошибка чата (${r.status})`;
      const err = new Error(errMsg);
      err.statusCode = r.status >= 400 && r.status < 600 ? r.status : 502;
      err.talkmeErrorDescr = data?.error?.descr || null;
      throw err;
    }

    return data.result;
  }

  // Сюда формально попасть нельзя (return/throw в каждой ветке), но на всякий случай.
  throw talkmeNetworkError(lastNetworkErr);
}

/** Best-effort label from Talk-Me /chat/message/getDialogStatusList result shape. */
function deriveDialogStatusLabel(result) {
  if (result == null) return null;
  if (typeof result === "string") return result;
  if (typeof result !== "object") return null;
  const r = result;

  const list = r.dialogStatusList || r.statuses || r.items;
  const curId =
    r.currentDialogStatusId ?? r.dialogStatusId ?? r.statusId ?? r.currentStatusId;

  if (Array.isArray(list) && curId != null) {
    const found = list.find(
      (x) =>
        x &&
        (x.id === curId ||
          String(x.id) === String(curId) ||
          x.dialogStatusId === curId),
    );
    if (found) {
      if (typeof found.name === "string") return found.name;
      if (typeof found.title === "string") return found.title;
      if (typeof found.descr === "string") return found.descr;
    }
  }

  if (typeof r.dialogStatusName === "string") return r.dialogStatusName;
  if (typeof r.dialogStatus === "string") return r.dialogStatus;
  if (typeof r.statusName === "string") return r.statusName;
  if (typeof r.name === "string") return r.name;

  if (Array.isArray(list) && list.length > 0) {
    const first = list[0];
    if (first && typeof first === "object") {
      if (typeof first.name === "string") return first.name;
      if (typeof first.title === "string") return first.title;
    }
  }

  return null;
}

/** Сколько операторов онлайн из ответа `/chat/operator/getList` (разные формы `result`). */
function countOnlineOperatorsFromGetListResult(result) {
  if (result == null) return 0;

  const collect = [];
  if (Array.isArray(result)) {
    collect.push(...result);
  } else if (typeof result === "object") {
    const r = result;
    for (const key of ["operators", "items", "operatorList", "list", "data"]) {
      const list = r[key];
      if (Array.isArray(list) && list.length > 0) {
        collect.push(...list);
        break;
      }
    }
    if (collect.length === 0 && Array.isArray(r.groups)) {
      for (const g of r.groups) {
        const ops = g?.operators || g?.items;
        if (Array.isArray(ops)) collect.push(...ops);
      }
    }
  }

  if (collect.length === 0) return 0;

  const rowOnline = (op) => {
    if (!op || typeof op !== "object") return false;
    if (op.isOnline === true || op.online === true) return true;
    if (op.inNetwork === true || op.isInNetwork === true) return true;
    if (op.connected === true) return true;
    if (op.statusId === 1 || op.statusId === "1") return true;
    if (op.statusId === 0 || op.statusId === "0" || op.statusId === -1 || op.statusId === "-1") {
      return false;
    }
    if (op.isWorkingNow === true) return true;
    const st = op.status;
    if (typeof st === "string") {
      const s = st.trim().toLowerCase();
      if (s === "online" || s === "busy" || s === "available" || s === "в сети") {
        return true;
      }
    }
    if (st === 1) return true;
    return false;
  };

  const withFlags = collect.filter((op) => {
    if (!op || typeof op !== "object") return false;
    return (
      "isOnline" in op ||
      "online" in op ||
      "inNetwork" in op ||
      "isInNetwork" in op ||
      "connected" in op ||
      "statusId" in op ||
      "isWorkingNow" in op ||
      "status" in op
    );
  });

  if (withFlags.length > 0) {
    return withFlags.filter(rowOnline).length;
  }

  // Если в объектах нет явных полей статуса — часто API отдаёт только онлайн-операторов.
  return collect.length;
}

  app.post("/api/talkme/client-search", ...talkmeProtected, async (req, res) => {
  try {
    const { clients, selected } = await resolveTalkMeVisitor(req);
    return res.json({ clients, selected });
  } catch (err) {
    const { message, status } = talkmeRouteError(err);
    return res.status(status).json({ error: message });
  }
});

  app.post("/api/talkme/client-id", ...talkmeProtected, (req, res) => {
  const { clientId } = getTalkMeIdentity(req);
  return res.json({ clientId });
});

  app.post("/api/talkme/messages", ...talkmeProtected, async (req, res) => {
  try {
    const lookup = await resolveClientLookup(req, res, req.body);
    if (!lookup) return;
    if (!lookup.client) {
      return res.json({ messages: [], count: 0, searchId: null, hasVisitor: false });
    }

    const { afterId, limit: rawLimit } = req.body;
    const body = {
      client: lookup.client,
      orderDirection: "asc",
      limit: Math.min(Math.max(Number(rawLimit) || 100, 1), 500),
    };

    if (typeof afterId === "number" && afterId > 0) {
      body.firstMessageId = afterId;
    }

    const result = await talkmeRequest("/chat/message/getClientMessageList", body);
    const items = result?.items || [];

    const messages = items
      .filter((m) => m.isVisibleForClient !== false && m.messageType !== "comment")
      .map((m) => ({
        id: m.id,
        text: m.text || m.content?.text || "",
        sender: m.whoSend === "operator" ? "operator" : "client",
        operatorName: m.operatorName || null,
        dateTime: m.dateTimeUTC || m.dateTime || "",
        status: m.status || "",
      }));

    return res.json({
      messages,
      count: result?.count || 0,
      searchId: lookup.searchId,
      hasVisitor: true,
    });
  } catch (err) {
    const { message, status } = talkmeRouteError(err);
    return res.status(status).json({ error: message });
  }
});

  app.post("/api/support/chat-attachment", ...uploadProtected, (req, res) => {
  supportChatUpload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: `Размер файла превышает ${Math.floor(SUPPORT_CHAT_MAX_FILE_SIZE / (1024 * 1024))} МБ`,
        });
      }
      return res.status(400).json({ error: err.message || "Не удалось загрузить файл" });
    }
    if (err) {
      return res.status(400).json({ error: err.message || "Не удалось загрузить файл" });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "Файл обязателен" });
    }

    const ext = getChatFileExtension(file);
    const mimeType = String(file.mimetype || "").toLowerCase();
    const kind = getChatAttachmentKind({ ext, mimeType });
    const path = `/api/support/chat-attachment/${encodeURIComponent(file.filename)}`;
    const url = buildPublicUrl(req, path);

    return res.json({
      url,
      path,
      fileName: file.originalname,
      mimeType,
      size: file.size,
      kind,
    });
  });
});

/**
 * Принимаем `custom` как `Record<string, string>` (например, `Traffic`, `Devices`,
 * `Tariff`, `Expiration_date`) и передаём его в Talk-Me как `client.customData`
 * (имя ключа в REST согласно официальному Swift SDK Talk-Me: см.
 * `ChatController.setInfoCustomDataValue` → `chat/client/setInfo`).
 * Не-строковые/пустые значения отбрасываем, имена ключей ограничиваем
 * безопасным набором символов.
 */
function sanitizeTalkmeCustom(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(k)) continue;
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    out[k] = trimmed.slice(0, 256);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Обновляет карточку клиента в Talk-Me через REST `chat/client/setInfo`.
 *
 * Это правильный эндпоинт для записи произвольных полей в карточку клиента
 * (в отличие от `chat/message/sendToOperator`, который игнорирует `client.custom`,
 * см. https://github.com/bekannax/OnlineChatSdk-Swift `ChatController.setInfoCustomDataValue`).
 *
 * Шлём поля и под ключом `customData` (как в Swift SDK), и под ключом `custom`
 * (как в JS-виджете Talk-Me) — чтобы максимизировать совместимость
 * между разными версиями серверного API.
 *
 * Best-effort: ошибки логируем, но не пробрасываем — чтобы не валить отправку
 * сообщения пользователя из-за вспомогательного апдейта профиля.
 */
async function setTalkmeClientInfo({ clientId, name, email, customData }) {
  if (!clientId || (!name && !email && (!customData || Object.keys(customData).length === 0))) {
    return;
  }

  const client = { id: clientId };
  if (name) client.name = name;
  if (email) client.email = email;
  if (customData && Object.keys(customData).length > 0) {
    client.customData = customData;
    client.custom = customData;
  }

  const payload = { client };
  console.info(
    "[talkme/setInfo] → chat/client/setInfo payload:",
    JSON.stringify(payload),
  );

  try {
    const result = await talkmeRequest("/chat/client/setInfo", payload);
    console.info(
      "[talkme/setInfo] ← chat/client/setInfo result:",
      JSON.stringify(result ?? null),
    );
  } catch (err) {
    console.error(
      "[talkme/setInfo] ✕ chat/client/setInfo failed:",
      err?.message || err,
    );
  }
}

  app.post("/api/talkme/send", ...talkmeProtected, async (req, res) => {
  try {
    const { text, attachmentUrl, attachmentName, name, custom } = req.body;
    const { email: trimmedEmail, clientId } = getTalkMeIdentity(req);
    const trimmedName = typeof name === "string" ? name.trim() : "";
    const sanitizedCustom = sanitizeTalkmeCustom(custom);

    const trimmedText = typeof text === "string" ? text.trim() : "";
    const trimmedAttachmentUrl =
      typeof attachmentUrl === "string" ? attachmentUrl.trim() : "";
    const trimmedAttachmentName =
      typeof attachmentName === "string" ? attachmentName.trim() : "";

    if (!trimmedText && !trimmedAttachmentUrl) {
      return res.status(400).json({ error: "Требуется текст или файл" });
    }

    if (trimmedAttachmentUrl && !isAllowedAttachmentUrl(trimmedAttachmentUrl, req)) {
      return res.status(400).json({ error: "Ссылка на вложение должна указывать на загруженный файл" });
    }

    const messageParts = [];
    if (trimmedText) messageParts.push(trimmedText);
    if (trimmedAttachmentUrl) {
      messageParts.push(`Файл: ${trimmedAttachmentName || "вложение"}`);
      messageParts.push(trimmedAttachmentUrl);
    }

    await setTalkmeClientInfo({
      clientId,
      name: trimmedName,
      email: trimmedEmail,
      customData: sanitizedCustom,
    });

    const client = { id: clientId, email: trimmedEmail };
    if (trimmedName) client.name = trimmedName;

    const sendPayload = {
      client,
      message: { text: messageParts.join("\n") },
    };

    console.info(
      "[talkme/send] → sendToOperator payload:",
      JSON.stringify(sendPayload),
    );

    let result;
    try {
      result = await talkmeRequest("/chat/message/sendToOperator", sendPayload);
    } catch (talkmeErr) {
      console.error(
        "[talkme/send] ✕ sendToOperator failed:",
        talkmeErr?.message || talkmeErr,
      );
      throw talkmeErr;
    }

    console.info(
      "[talkme/send] ← sendToOperator result:",
      JSON.stringify(result),
    );

    const rawMessageId = result?.id ?? result?.messageId ?? result?.message?.id ?? null;
    const numericMessageId = Number(rawMessageId);
    const messageId = Number.isFinite(numericMessageId) && numericMessageId > 0 ? numericMessageId : null;
    return res.json({ messageId, clientId });
  } catch (err) {
    const { message, status } = talkmeRouteError(err);
    return res.status(status).json({ error: message });
  }
});

  app.post("/api/talkme/message-status", ...talkmeProtected, async (req, res) => {
  try {
    const { messageId, status, operatorLogin } = req.body || {};
    const mid = Number(messageId);
    if (!Number.isInteger(mid) || mid <= 0) {
      return res.status(400).json({ error: "Некорректный идентификатор сообщения" });
    }
    const allowedStatuses = new Set(["delivered", "readed"]);
    if (typeof status !== "string" || !allowedStatuses.has(status)) {
      return res.status(400).json({ error: "Некорректный статус сообщения" });
    }

    const body = { messageId: mid, status };
    // operatorLogin уместен только когда оператор читает сообщение клиента.
    // Для «клиент прочитал сообщение оператора» — не передаём (это поведение Talk-Me API).
    if (typeof operatorLogin === "string" && operatorLogin.trim()) {
      body.operatorLogin = operatorLogin.trim();
    }

    try {
      await talkmeRequest("/chat/message/setStatus", body);
    } catch (err) {
      // Talk-Me возвращает `success: false, error.descr: "Ничего не изменилось"`,
      // если статус уже был выставлен (или эскалирован выше). Это не ошибка —
      // считаем no-op и отвечаем 200, чтобы клиент не ретраил и не сыпал 502 в консоль.
      const descr = (err?.talkmeErrorDescr || err?.message || "").toLowerCase();
      if (descr.includes("ничего не изменилось")) {
        return res.json({ success: true, noop: true });
      }
      throw err;
    }
    return res.json({ success: true });
  } catch (err) {
    const { message, status } = talkmeRouteError(err);
    return res.status(status).json({ error: message });
  }
});

  app.post("/api/talkme/dialog-status", ...talkmeProtected, async (req, res) => {
  try {
    const lookup = await resolveClientLookup(req, res, req.body);
    if (!lookup) return;
    if (!lookup.client) return res.json({ statusLabel: null, raw: null });

    const body = { client: lookup.client };

    const result = await talkmeRequest("/chat/message/getDialogStatusList", body);
    const statusLabel = deriveDialogStatusLabel(result);

    return res.json({ statusLabel, raw: result });
  } catch (err) {
    const { message, status } = talkmeRouteError(err);
    return res.status(status).json({ error: message });
  }
});

/**
 * In-memory регистр «оператор печатает для клиента X».
 *
 * Поскольку Talk-Me REST не предоставляет ни `getTypingStatus`, ни webhook-события
 * на typing, а наш UI `Chat.tsx` не использует виджет Talk-Me — индикатор
 * «оператор печатает…» приходится моделировать на нашей стороне:
 *   - каждый вызов `POST /api/talkme/send-typing` обновляет запись
 *     `{clientId → expiresAt}` (помимо проксирования в Talk-Me),
 *   - фронт поллит `POST /api/talkme/operator-typing-status` и рисует
 *     анимированный «typing» pill при `expiresAt > now`.
 *
 * Это согласуется с семантикой: запись «печатает оператор X для клиента Y» живёт
 * ровно `ttl` секунд (default 30), точно как имитация в виджете Talk-Me.
 */
const operatorTypingState = new Map();

function setOperatorTyping(clientId, ttlSeconds, operatorLogin) {
  if (!clientId) return;
  const expiresAt = Date.now() + Math.max(1, ttlSeconds) * 1000;
  operatorTypingState.set(clientId, {
    expiresAt,
    operatorLogin: operatorLogin || null,
  });
}

function getOperatorTyping(clientId) {
  if (!clientId) return null;
  const entry = operatorTypingState.get(clientId);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt <= now) {
    operatorTypingState.delete(clientId);
    return null;
  }
  return {
    operatorLogin: entry.operatorLogin,
    secondsLeft: Math.max(0, Math.ceil((entry.expiresAt - now) / 1000)),
  };
}

/**
 * Прокси к Talk-Me `POST /chat/message/sendTypingToClient` — имитация набора
 * сообщения оператором (направление: оператор → клиент).
 *
 * Документация: https://lcab.talk-me.ru/cabinet/json-doc/online#tag/Chatmessage/paths/~1chat~1message~1sendTypingToClient/post
 *
 * Тело запроса:
 *   - `clientId` (string) или `searchId` (int) — идентификация клиента (хотя бы одно).
 *   - `operatorLogin` (string, обяз.) — логин оператора, от чьего имени идёт «набор».
 *   - `virtual` (bool, default true) — если true, Talk-Me не проверяет существование логина.
 *   - `ttl` (int, default 30) — длительность имитации в секундах.
 *
 * Помимо проксирования в Talk-Me, обновляет внутренний регистр
 * `operatorTypingState` — его читает наш `Chat.tsx`, чтобы показать
 * пользователю анимированный индикатор «Оператор печатает…».
 */
  app.post("/api/talkme/send-typing", ...talkmeProtected, async (req, res) => {
  try {
    const { clientId, searchId, operatorLogin, virtual, ttl } = req.body || {};

    const lookup = await resolveClientLookup(req, res, { clientId, searchId });
    if (!lookup) return;

    const login = typeof operatorLogin === "string" ? operatorLogin.trim() : "";
    if (!login) {
      return res.status(400).json({ error: "Требуется логин оператора" });
    }

    const trimmedClientId = getTalkMeIdentity(req).clientId;
    const client = lookup.client ?? { clientId: trimmedClientId };
    const operator = { login, virtual: virtual === false ? false : true };

    const body = { client, operator };

    let ttlSeconds = 30;
    if (ttl !== undefined && ttl !== null) {
      const ttlNum = Number(ttl);
      if (!Number.isInteger(ttlNum) || ttlNum <= 0 || ttlNum > 300) {
        return res
          .status(400)
          .json({ error: "ttl должен быть целым числом от 1 до 300 секунд" });
      }
      body.ttl = ttlNum;
      ttlSeconds = ttlNum;
    }

    let noop = false;
    try {
      await talkmeRequest("/chat/message/sendTypingToClient", body);
    } catch (err) {
      const descr = (err?.talkmeErrorDescr || err?.message || "").toLowerCase();
      if (descr.includes("ничего не изменилось")) {
        noop = true;
      } else {
        throw err;
      }
    }

    setOperatorTyping(trimmedClientId, ttlSeconds, login);

    return res.json({ success: true, ...(noop ? { noop: true } : {}) });
  } catch (err) {
    const { message, status } = talkmeRouteError(err);
    return res.status(status).json({ error: message });
  }
});

/**
 * Возвращает локальное состояние «оператор печатает для клиента X», которое
 * обновляется при вызовах `POST /api/talkme/send-typing`. Используется
 * `Chat.tsx` для отрисовки typing-индикатора в кастомном UI чата.
 *
 * Тело запроса: `{ clientId: string }`.
 * Ответ: `{ typing: bool, operatorLogin: string | null, secondsLeft: number }`.
 */
  app.post("/api/talkme/operator-typing-status", ...talkmeProtected, (req, res) => {
  const trimmedClientId = assertSessionClientId(req, res, req.body?.clientId);
  if (!trimmedClientId) return;

  const state = getOperatorTyping(trimmedClientId);
  if (!state) {
    return res.json({ typing: false, operatorLogin: null, secondsLeft: 0 });
  }
  return res.json({
    typing: true,
    operatorLogin: state.operatorLogin,
    secondsLeft: state.secondsLeft,
  });
});

/** Прокси к Talk-Me `POST /chat/operator/getList` — список операторов и признак онлайн. */
  app.post("/api/talkme/operator-list", ...talkmeProtected, async (req, res) => {
  try {
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};
    const result = await talkmeRequest("/chat/operator/getList", body);
    const onlineCount = countOnlineOperatorsFromGetListResult(result);
    return res.json({ onlineCount });
  } catch (err) {
    const { message, status } = talkmeRouteError(err);
    return res.status(status).json({ error: message });
  }
});
}
