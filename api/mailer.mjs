// OTP email sender (SMTP transports via nodemailer).
//
// Primary provider: AWS SES (SES_SMTP_*). Optional backup provider: any SMTP
// relay configured via BACKUP_SMTP_* (e.g. Unisender Go on 587/STARTTLS); it is
// used for code resends and as a one-shot failover (see sendOtpEmail).
//
// SES SMTP credentials are NOT the same as IAM access keys: they are generated
// in the SES console (SMTP settings → Create SMTP credentials). The IAM user
// behind them should only have `ses:SendRawEmail` on the verified From identity
// (least privilege).
//
// Security notes:
// - Plain credentials live in .env (chmod 600). Rotate via SES console.
// - Connection is TLS-only (implicit on 465, STARTTLS-required on 587).
// - We never log the OTP code, the recipient email in clear text, or the
//   SMTP password. Callers must pass an already validated 5-digit code.
// - sendOtpEmail returns { ok, ... } and never throws SMTP details to the
//   route handler — that prevents leaking provider errors to clients.

import nodemailer from "nodemailer";
import { emailHash, maskEmail } from "./auth/crypto.mjs";
import { logger } from "./logger.mjs";
import { UNISENDER_HEADER_NAME, UNISENDER_HEADER_VALUE } from "./email/unisenderBrand.mjs";

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Провайдеры отправки OTP: "primary" — AWS SES (SES_SMTP_*), "backup" —
// опциональный второй SMTP (BACKUP_SMTP_*, например Unisender Go). Какой из них
// использовать, решает вызывающий код (повторная отправка кода → backup), а
// sendOtpEmail при ошибке выбранного провайдера один раз пробует другой.
export const MAIL_PROVIDERS = Object.freeze({ PRIMARY: "primary", BACKUP: "backup" });

// Транспорты создаются лениво и кэшируются отдельно для каждого провайдера.
const cachedTransports = new Map();

function evictCachedTransport(provider) {
  // Закрываем пул нашего нодмэйлер-транспорта. Это важно делать после
  // транзиентной ошибки SMTP: иначе следующий sendMail снова возьмёт из пула
  // ту же мёртвую TCP-сессию (AWS SES / NAT закрывают коннект после простоя,
  // а пул об этом не узнаёт до первой неудачной записи).
  const providers = provider ? [provider] : [...cachedTransports.keys()];
  for (const name of providers) {
    const cached = cachedTransports.get(name);
    if (cached) {
      try {
        cached.transport.close();
      } catch {
        // close идемпотентен и не должен ронять отправителя
      }
    }
    cachedTransports.delete(name);
  }
}

function isRetryableSmtpError(err) {
  if (!err || typeof err !== "object") return false;

  const code = typeof err.code === "string" ? err.code.toUpperCase() : "";
  const responseCode = Number(err.responseCode) || 0;
  const message = typeof err.message === "string" ? err.message.toLowerCase() : "";

  // Сетевые/сокетные ошибки — почти всегда означают, что соединение из пула
  // умерло (RST / idle close на стороне SES) или таймаут на конкретной операции
  // SMTP. В обоих случаях имеет смысл попробовать ещё раз со свежим сокетом.
  const transientCodes = new Set([
    "ECONNECTION",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "ESOCKET",
    "EAI_AGAIN",
    "EDNS",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
  ]);
  if (transientCodes.has(code)) return true;

  // SMTP 4xx — временная ошибка со стороны сервера (greylisting, throttling).
  if (responseCode >= 400 && responseCode < 500) return true;

  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("socket hang up") ||
    message.includes("connection closed")
  ) {
    return true;
  }

  return false;
}

function readPrimarySmtpConfig() {
  const host = (process.env.SES_SMTP_HOST || "").trim();
  const portRaw = (process.env.SES_SMTP_PORT || "465").trim();
  const port = Number.parseInt(portRaw, 10);
  const user = (process.env.SES_SMTP_USER || "").trim();
  const pass = (process.env.SES_SMTP_PASSWORD || "").trim();

  const missing = [
    !host && "SES_SMTP_HOST",
    !user && "SES_SMTP_USER",
    !pass && "SES_SMTP_PASSWORD",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`SES SMTP is not configured (missing: ${missing.join(", ")})`);
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`SES_SMTP_PORT is invalid: ${portRaw}`);
  }
  // Как и раньше: 465 — implicit TLS, любой другой порт — обязательный STARTTLS.
  return { host, port, user, pass, secure: port === 465 };
}

// Резервный SMTP считается настроенным, только если заданы host, user и password.
export function isBackupMailerConfigured() {
  return Boolean(
    (process.env.BACKUP_SMTP_HOST || "").trim() &&
      (process.env.BACKUP_SMTP_USER || "").trim() &&
      (process.env.BACKUP_SMTP_PASSWORD || "").trim(),
  );
}

function readBackupSmtpConfig() {
  if (!isBackupMailerConfigured()) {
    throw new Error("Backup SMTP is not configured");
  }
  const host = process.env.BACKUP_SMTP_HOST.trim();
  const portRaw = (process.env.BACKUP_SMTP_PORT || "587").trim();
  const port = Number.parseInt(portRaw, 10);
  const user = process.env.BACKUP_SMTP_USER.trim();
  const pass = process.env.BACKUP_SMTP_PASSWORD.trim();
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`BACKUP_SMTP_PORT is invalid: ${portRaw}`);
  }
  // По умолчанию порт 587 со STARTTLS (requireTLS), implicit TLS — только явно.
  const secure = (process.env.BACKUP_SMTP_SECURE || "false").trim().toLowerCase() === "true";
  return { host, port, user, pass, secure };
}

function readSmtpConfig(provider = MAIL_PROVIDERS.PRIMARY) {
  return provider === MAIL_PROVIDERS.BACKUP ? readBackupSmtpConfig() : readPrimarySmtpConfig();
}

function readSenderConfig(provider = MAIL_PROVIDERS.PRIMARY) {
  // Резерв по умолчанию шлёт от того же имени и адреса, что и SES.
  const backup = provider === MAIL_PROVIDERS.BACKUP;
  const backupName = backup ? (process.env.BACKUP_MAIL_FROM_NAME || "").trim() : "";
  const backupEmail = backup ? (process.env.BACKUP_MAIL_FROM_EMAIL || "").trim() : "";
  const name = backupName || (process.env.MAIL_FROM_NAME || "220v").trim();
  const email = backupEmail || (process.env.MAIL_FROM_EMAIL || "").trim();
  const emailVar = backupEmail ? "BACKUP_MAIL_FROM_EMAIL" : "MAIL_FROM_EMAIL";
  if (!email) {
    throw new Error("MAIL_FROM_EMAIL is not configured");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`${emailVar} is not a valid email address`);
  }
  return { name, email };
}

function maskSmtpUser(user) {
  if (!user || typeof user !== "string") return "";
  if (user.length <= 4) return "***";
  return `${user.slice(0, 4)}***`;
}

function formatSmtpError(err) {
  if (!err || typeof err !== "object") {
    return { message: String(err || "unknown smtp error") };
  }
  return {
    code: err.code || null,
    responseCode: err.responseCode || null,
    command: err.command || null,
    response: typeof err.response === "string" ? err.response.slice(0, 500) : null,
    message: typeof err.message === "string" ? err.message.slice(0, 500) : null,
  };
}

function buildTransport(provider = MAIL_PROVIDERS.PRIMARY) {
  const cfg = readSmtpConfig(provider);
  const key = `${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}`;
  const cached = cachedTransports.get(provider);
  if (cached && cached.key === key) {
    return cached.transport;
  }
  if (cached) evictCachedTransport(provider);
  logger.info(
    {
      provider,
      smtpHost: cfg.host,
      smtpPort: cfg.port,
      smtpUser: maskSmtpUser(cfg.user),
    },
    "mailer transport created",
  );
  // Таймауты выбраны так, чтобы две последовательные попытки sendMail
  // (см. sendOtpEmail) укладывались в proxy_read_timeout nginx для
  // /api/auth/send-code (25s). Если первая попытка наткнётся на «зомби»-
  // соединение из пула, мы хотим узнать об этом быстро и успеть переотправить
  // письмо в том же запросе — поэтому socketTimeout держим тугим.
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 7_000,
    greetingTimeout: 7_000,
    socketTimeout: 8_000,
    tls: { minVersion: "TLSv1.2" },
  });
  cachedTransports.set(provider, { transport, key });
  return transport;
}

// purpose: "login" (default) — вход по коду; "password_change" — подтверждение
// установки/смены пароля в личном кабинете.
export function buildOtpMessage(code, purpose = "login") {
  const safeCode = escapeHtml(code);
  const changingPassword = purpose === "password_change";
  const subject = changingPassword ? "Код для смены пароля в 220v" : `Ваш код для входа в 220v`;
  const copy = changingPassword
    ? {
        requested: "Вы запросили установку или смену пароля в личном кабинете.",
        instruction: "Введите его в окне смены пароля. Код действует 10 минут.",
        unrequested: "Если вы не запрашивали смену пароля, просто удалите это письмо — ваш пароль не изменится.",
        preheader: `Код для смены пароля в 220v: ${safeCode}. Действует 10 минут.`,
        badge: "Смена пароля",
        hint: "Скопируйте код и вставьте его в окне смены пароля",
        usage: "и подходит только для одной смены пароля.",
        footer: "Не запрашивали смену пароля? Проигнорируйте письмо — пароль останется прежним.",
      }
    : {
        requested: "Вы запросили вход в личный кабинет.",
        instruction: "Введите его на странице входа. Код действует 10 минут.",
        unrequested: "Если вы не запрашивали вход, просто удалите это письмо.",
        preheader: `Код для входа в 220v: ${safeCode}. Действует 10 минут.`,
        badge: "Подтверждение входа",
        hint: "Скопируйте код и вставьте его на странице входа",
        usage: "и подходит только для одного входа.",
        footer: "Не запрашивали вход? Просто проигнорируйте это письмо.",
      };
  const text = [
    "220v · безопасный VPN",
    "",
    copy.requested,
    "",
    `Ваш код подтверждения: ${code}`,
    "",
    copy.instruction,
    "",
    "Не сообщайте код никому — команда 220v никогда не просит его по почте или в чате.",
    copy.unrequested,
    "",
    "220v",
    "support@220v.shop",
  ].join("\n");

  const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#0a0a0a;font-family:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;">
    <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;font-size:1px;line-height:1px;mso-hide:all;">
      ${copy.preheader}
    </span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#141414;border:1px solid #262626;border-radius:28px;overflow:hidden;">
            <tr>
              <td style="padding:36px 32px 0 32px;text-align:center;">
                <div style="font-size:28px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;line-height:1.1;">
                  220<span style="color:#c6ff3d;">v</span>
                </div>
                <div style="margin-top:10px;font-size:14px;font-weight:500;color:#9a9a9a;line-height:1.5;">
                  Безопасный VPN · личный кабинет
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:28px 24px 32px 24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#111111;border:1px solid #262626;border-radius:18px;">
                  <tr>
                    <td style="padding:28px 24px 8px 24px;text-align:center;">
                      <div style="display:inline-block;padding:6px 14px;background:rgba(198,255,61,0.12);border:1px solid rgba(198,255,61,0.25);border-radius:999px;font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#c6ff3d;">
                        ${copy.badge}
                      </div>
                      <div style="margin-top:18px;font-size:22px;font-weight:800;color:#ffffff;line-height:1.3;">
                        Ваш одноразовый код
                      </div>
                      <div style="margin-top:8px;font-size:14px;color:#9a9a9a;line-height:1.6;">
                        ${copy.hint}
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:20px 24px 8px 24px;text-align:center;">
                      <div style="display:inline-block;padding:20px 28px;background:#0a0a0a;border:1px solid #262626;border-radius:16px;box-shadow:0 0 0 1px rgba(198,255,61,0.08),0 18px 40px rgba(0,0,0,0.35);font-size:40px;font-weight:800;letter-spacing:12px;color:#c6ff3d;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;">
                        ${safeCode}
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 28px 28px 28px;text-align:center;">
                      <div style="font-size:14px;color:#c7c7c7;line-height:1.7;">
                        Код действует <strong style="color:#ffffff;">10&nbsp;минут</strong> ${copy.usage}
                      </div>
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
                  <tr>
                    <td style="padding:18px 20px;background:#1a1a1a;border:1px solid #262626;border-radius:14px;">
                      <div style="font-size:13px;color:#9a9a9a;line-height:1.7;text-align:center;">
                        <strong style="color:#ffffff;">Не передавайте код третьим лицам.</strong><br />
                        Сотрудники 220v никогда не запрашивают его в письмах, чатах или звонках.<br />
                        ${copy.footer}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 32px 28px 32px;border-top:1px solid #262626;text-align:center;">
                <div style="padding-top:22px;font-size:12px;color:#9a9a9a;line-height:1.7;">
                  © 220v · <a href="mailto:support@220v.shop" style="color:#c6ff3d;text-decoration:none;font-weight:600;">support@220v.shop</a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

// Backup mail (Unisender Go) carries the brand in X-UNISENDER-GO global_metadata,
// so this site's webhook can tell its own events apart. SES mail is unchanged.
function buildMessage(provider, from, email, subject, text, html) {
  const headers = {
    "X-Entity-Ref-ID": `otp-${Date.now().toString(36)}`,
    "Auto-Submitted": "auto-generated",
  };
  if (provider === MAIL_PROVIDERS.BACKUP) headers[UNISENDER_HEADER_NAME] = UNISENDER_HEADER_VALUE;
  return {
    from: { name: from.name, address: from.email },
    to: email,
    subject,
    text,
    html,
    headers,
  };
}

// Отправка через один провайдер. maxAttempts > 1 включает повтор на свежем
// сокете после транзиентной ошибки (протухший пул SES).
async function sendViaProvider({ provider, email, recipientDomain, content, maxAttempts }) {
  let from;
  let transport;
  try {
    from = readSenderConfig(provider);
    transport = buildTransport(provider);
  } catch (err) {
    logger.error(
      { provider, err: formatSmtpError(err), emailHash: emailHash(email), maskedEmail: maskEmail(email) },
      "mailer not configured",
    );
    return {
      ok: false,
      error: "mailer_not_configured",
      detail: err?.message || "mailer not configured",
    };
  }

  logger.info(
    {
      provider,
      emailHash: emailHash(email),
      maskedEmail: maskEmail(email),
      recipientDomain,
      fromEmail: from.email,
      fromName: from.name,
      purpose: content.purpose,
    },
    "mailer sending otp email",
  );

  const message = buildMessage(provider, from, email, content.subject, content.text, content.html);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAtMs = Date.now();
    try {
      const info = await transport.sendMail(message);
      return { ok: true, messageId: info?.messageId || null, elapsedMs: Date.now() - startedAtMs, attempt };
    } catch (err) {
      lastError = err;
      const elapsedMs = Date.now() - startedAtMs;
      const smtpErr = formatSmtpError(err);
      const retryable = attempt < maxAttempts && isRetryableSmtpError(err);

      logger.warn(
        {
          provider,
          emailHash: emailHash(email),
          maskedEmail: maskEmail(email),
          recipientDomain,
          fromEmail: from.email,
          smtp: smtpErr,
          elapsedMs,
          attempt,
          willRetry: retryable,
        },
        "mailer smtp send attempt failed",
      );

      // Пул после ошибки сбрасываем всегда: следующая отправка (повтор, другой
      // запрос) должна идти на свежем сокете.
      evictCachedTransport(provider);
      if (!retryable) break;

      try {
        transport = buildTransport(provider);
      } catch (rebuildErr) {
        logger.error(
          { provider, err: formatSmtpError(rebuildErr), emailHash: emailHash(email) },
          "mailer transport rebuild failed during retry",
        );
        lastError = rebuildErr;
        break;
      }
    }
  }

  const smtpErr = formatSmtpError(lastError);
  logger.error(
    {
      provider,
      emailHash: emailHash(email),
      maskedEmail: maskEmail(email),
      recipientDomain,
      fromEmail: from.email,
      smtp: smtpErr,
    },
    "mailer smtp send failed",
  );
  const errCode = smtpErr.responseCode || smtpErr.code || null;
  return {
    ok: false,
    error: "smtp_error",
    detail: errCode ? String(errCode) : smtpErr.message || "smtp failure",
  };
}

/**
 * provider: "primary" (SES, по умолчанию) или "backup" (BACKUP_SMTP_*). Если
 * резервный SMTP не настроен, всегда используется primary — как раньше.
 * При ошибке выбранного провайдера один раз пробуем другой.
 *
 * @returns {Promise<{ ok: true, messageId: string | null, provider: string, failover: boolean } | { ok: false, error: string, detail?: string, provider?: string, failover?: boolean }>}
 */
export async function sendOtpEmail({ email, code, purpose = "login", provider = MAIL_PROVIDERS.PRIMARY }) {
  const recipientDomain =
    typeof email === "string" && email.includes("@") ? email.slice(email.indexOf("@") + 1) : null;

  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    logger.warn({ recipientDomain }, "mailer rejected invalid recipient");
    return { ok: false, error: "invalid_recipient" };
  }
  if (typeof code !== "string" || !/^\d{5}$/.test(code)) {
    logger.warn({ emailHash: emailHash(email) }, "mailer rejected invalid otp code format");
    return { ok: false, error: "invalid_code" };
  }

  const backupConfigured = isBackupMailerConfigured();
  const requested = provider === MAIL_PROVIDERS.BACKUP ? MAIL_PROVIDERS.BACKUP : MAIL_PROVIDERS.PRIMARY;
  const chosen = backupConfigured ? requested : MAIL_PROVIDERS.PRIMARY;
  const order = backupConfigured
    ? [chosen, chosen === MAIL_PROVIDERS.BACKUP ? MAIL_PROVIDERS.PRIMARY : MAIL_PROVIDERS.BACKUP]
    : [MAIL_PROVIDERS.PRIMARY];

  const { subject, text, html } = buildOtpMessage(code, purpose);
  const content = { subject, text, html, purpose };

  // Без резерва — до двух попыток через SES: если соединение из пула
  // «протухло» (AWS SES закрыл idle TCP, а nodemailer об этом не узнал), первая
  // sendMail быстро упадёт с ECONNRESET / ETIMEDOUT / socket hang up, и мы
  // повторим на свежем сокете. С резервом роль повтора играет второй
  // провайдер: по одной попытке на каждого, чтобы суммарно уложиться в те же
  // две попытки и в таймаут nginx.
  const maxAttempts = order.length > 1 ? 1 : 2;
  let result = null;

  for (let i = 0; i < order.length; i++) {
    const current = order[i];
    result = await sendViaProvider({ provider: current, email, recipientDomain, content, maxAttempts });
    if (result.ok) {
      const failover = current !== chosen;
      logger.info(
        {
          emailHash: emailHash(email),
          provider: current,
          requestedProvider: chosen,
          failover,
          messageId: result.messageId,
          elapsedMs: result.elapsedMs,
          attempt: result.attempt,
        },
        "mailer otp email sent",
      );
      return { ok: true, messageId: result.messageId, provider: current, failover };
    }
    if (i + 1 < order.length) {
      logger.warn(
        { emailHash: emailHash(email), failedProvider: current, nextProvider: order[i + 1] },
        "mailer failing over to another smtp provider",
      );
    }
  }

  return { ...result, provider: chosen, failover: order.length > 1 };
}

function summarizeProvider(provider) {
  const smtp = readSmtpConfig(provider);
  const from = readSenderConfig(provider);
  return {
    smtpHost: smtp.host,
    smtpPort: smtp.port,
    smtpUser: maskSmtpUser(smtp.user),
    fromEmail: from.email,
    fromName: from.name,
  };
}

export function getMailerConfigSummary() {
  let summary;
  try {
    summary = { ok: true, ...summarizeProvider(MAIL_PROVIDERS.PRIMARY) };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "mailer not configured",
    };
  }
  if (!isBackupMailerConfigured()) {
    summary.backup = { configured: false };
    return summary;
  }
  try {
    summary.backup = { configured: true, ...summarizeProvider(MAIL_PROVIDERS.BACKUP) };
  } catch (err) {
    summary.backup = { configured: true, error: err?.message || "backup mailer misconfigured" };
  }
  return summary;
}

export async function verifyMailerConfig() {
  const summary = getMailerConfigSummary();
  if (!summary.ok) {
    throw new Error(summary.error);
  }
  const transport = buildTransport(MAIL_PROVIDERS.PRIMARY);
  await transport.verify();
  // Резервный SMTP проверяем мягко: его недоступность не должна выглядеть
  // как поломка основного отправителя.
  if (summary.backup?.configured) {
    try {
      await buildTransport(MAIL_PROVIDERS.BACKUP).verify();
      logger.info({ provider: MAIL_PROVIDERS.BACKUP }, "mailer backup smtp connection verified");
    } catch (err) {
      logger.warn(
        { provider: MAIL_PROVIDERS.BACKUP, err: formatSmtpError(err) },
        "mailer backup smtp verify failed at startup",
      );
    }
  }
  return summary;
}

export function _resetMailerForTests() {
  evictCachedTransport();
}
