/**
 * Загрузка вложений чата поддержки — общая для провайдеров Talk-Me и Chatwoot.
 *
 * Файл сначала попадает на наш диск (валидация типа/размера здесь), а затем
 * провайдер решает, что с ним делать: Talk-Me получает ссылку текстом,
 * Chatwoot — сам файл multipart-ом.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, resolve, sep } from "node:path";
import express from "express";
import multer from "multer";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SUPPORT_CHAT_UPLOADS_DIR = resolve(
  process.env.SUPPORT_CHAT_UPLOADS_DIR?.trim() || resolve(__dirname, "uploads", "support-chat"),
);
const SUPPORT_CHAT_MAX_FILE_SIZE_MB = Number(process.env.SUPPORT_CHAT_MAX_FILE_SIZE_MB || "50");
export const SUPPORT_CHAT_MAX_FILE_SIZE =
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

const ATTACHMENT_PATH_PREFIX = "/api/support/chat-attachment/";

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

export function getChatAttachmentKind({ ext, mimeType }) {
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

/** Ссылка ведёт на файл, загруженный через наш `/api/support/chat-attachment` на этом же хосте. */
export function isAllowedAttachmentUrl(url, req) {
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

/**
 * Локальный путь к ранее загруженному вложению по его публичной ссылке.
 * Возвращает `null`, если ссылка не наша или пытается выйти из каталога загрузок.
 */
export function resolveUploadedAttachmentPath(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const idx = pathname.indexOf(ATTACHMENT_PATH_PREFIX);
  if (idx < 0) return null;
  let name;
  try {
    name = decodeURIComponent(pathname.slice(idx + ATTACHMENT_PATH_PREFIX.length));
  } catch {
    return null;
  }
  if (!name || name !== basename(name) || name.startsWith(".")) return null;
  const full = resolve(SUPPORT_CHAT_UPLOADS_DIR, name);
  if (!full.startsWith(SUPPORT_CHAT_UPLOADS_DIR + sep)) return null;
  return full;
}

/** Раздача загруженных файлов и `POST /api/support/chat-attachment`. */
export function registerSupportChatAttachmentRoutes(app, uploadProtected) {
  app.use(
    "/api/support/chat-attachment",
    (_req, res, next) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      next();
    },
    express.static(SUPPORT_CHAT_UPLOADS_DIR),
  );

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
      const path = `${ATTACHMENT_PATH_PREFIX}${encodeURIComponent(file.filename)}`;
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
}
