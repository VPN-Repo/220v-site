// AWS SES sender (SMTP transport via nodemailer).
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

let cachedTransport = null;
let cachedTransportKey = null;

function evictCachedTransport() {
  // Закрываем пул нашего нодмэйлер-транспорта. Это важно делать после
  // транзиентной ошибки SMTP: иначе следующий sendMail снова возьмёт из пула
  // ту же мёртвую TCP-сессию (AWS SES / NAT закрывают коннект после простоя,
  // а пул об этом не узнаёт до первой неудачной записи).
  if (cachedTransport) {
    try {
      cachedTransport.close();
    } catch {
      // close идемпотентен и не должен ронять отправителя
    }
  }
  cachedTransport = null;
  cachedTransportKey = null;
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

function readSmtpConfig() {
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
  return { host, port, user, pass };
}

function readSenderConfig() {
  const name = (process.env.MAIL_FROM_NAME || "220v").trim();
  const email = (process.env.MAIL_FROM_EMAIL || "").trim();
  if (!email) {
    throw new Error("MAIL_FROM_EMAIL is not configured");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("MAIL_FROM_EMAIL is not a valid email address");
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

function buildTransport() {
  const cfg = readSmtpConfig();
  const key = `${cfg.host}|${cfg.port}|${cfg.user}`;
  if (cachedTransport && cachedTransportKey === key) {
    return cachedTransport;
  }
  logger.info(
    {
      smtpHost: cfg.host,
      smtpPort: cfg.port,
      smtpUser: maskSmtpUser(cfg.user),
    },
    "mailer transport created",
  );
  const secure = cfg.port === 465;
  // Таймауты выбраны так, чтобы две последовательные попытки sendMail
  // (см. sendOtpEmail) укладывались в proxy_read_timeout nginx для
  // /api/auth/send-code (25s). Если первая попытка наткнётся на «зомби»-
  // соединение из пула, мы хотим узнать об этом быстро и успеть переотправить
  // письмо в том же запросе — поэтому socketTimeout держим тугим.
  cachedTransport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure,
    requireTLS: !secure,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 7_000,
    greetingTimeout: 7_000,
    socketTimeout: 8_000,
    tls: { minVersion: "TLSv1.2" },
  });
  cachedTransportKey = key;
  return cachedTransport;
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

export async function sendOtpEmail({ email, code, purpose = "login" }) {
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

  let from;
  let transport;
  try {
    from = readSenderConfig();
    transport = buildTransport();
  } catch (err) {
    logger.error(
      { err: formatSmtpError(err), emailHash: emailHash(email), maskedEmail: maskEmail(email) },
      "mailer not configured",
    );
    return {
      ok: false,
      error: "mailer_not_configured",
      detail: err?.message || "mailer not configured",
    };
  }

  const { subject, text, html } = buildOtpMessage(code, purpose);

  logger.info(
    {
      emailHash: emailHash(email),
      maskedEmail: maskEmail(email),
      recipientDomain,
      fromEmail: from.email,
      fromName: from.name,
      purpose,
    },
    "mailer sending otp email",
  );

  const message = {
    from: { name: from.name, address: from.email },
    to: email,
    subject,
    text,
    html,
    headers: {
      "X-Entity-Ref-ID": `otp-${Date.now().toString(36)}`,
      "Auto-Submitted": "auto-generated",
    },
  };

  // До двух попыток: если соединение из пула «протухло» (AWS SES закрыл idle
  // TCP, а nodemailer об этом не узнал), первая sendMail быстро упадёт с
  // ECONNRESET / ETIMEDOUT / socket hang up. Сбрасываем пул и шлём ещё раз
  // уже на свежем сокете. Без этого пользователь получает 502, хотя письмо
  // на «мёртвом» сокете до закрытия может всё-таки уйти в SES (отсюда репорт
  // «ошибка отправки, но письмо пришло»).
  const MAX_ATTEMPTS = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startedAtMs = Date.now();
    try {
      const info = await transport.sendMail(message);
      const elapsedMs = Date.now() - startedAtMs;
      logger.info(
        {
          emailHash: emailHash(email),
          messageId: info?.messageId || null,
          elapsedMs,
          attempt,
        },
        "mailer otp email sent",
      );
      return { ok: true, messageId: info?.messageId || null };
    } catch (err) {
      lastError = err;
      const elapsedMs = Date.now() - startedAtMs;
      const smtpErr = formatSmtpError(err);
      const retryable = attempt < MAX_ATTEMPTS && isRetryableSmtpError(err);

      logger.warn(
        {
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

      if (!retryable) break;

      evictCachedTransport();
      try {
        transport = buildTransport();
      } catch (rebuildErr) {
        logger.error(
          { err: formatSmtpError(rebuildErr), emailHash: emailHash(email) },
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

export function getMailerConfigSummary() {
  try {
    const smtp = readSmtpConfig();
    const from = readSenderConfig();
    return {
      ok: true,
      smtpHost: smtp.host,
      smtpPort: smtp.port,
      smtpUser: maskSmtpUser(smtp.user),
      fromEmail: from.email,
      fromName: from.name,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "mailer not configured",
    };
  }
}

export async function verifyMailerConfig() {
  const summary = getMailerConfigSummary();
  if (!summary.ok) {
    throw new Error(summary.error);
  }
  const transport = buildTransport();
  await transport.verify();
  return summary;
}

export function _resetMailerForTests() {
  evictCachedTransport();
}
