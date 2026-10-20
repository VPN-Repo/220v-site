import { FETCH_TIMEOUT_MS } from "../config.mjs";

export function isTimeoutError(err) {
  if (!err) return false;
  if (err.isTimeout === true) return true;
  if (err.name === "TimeoutError") return true;
  if (err.code === "ETIMEDOUT" || err.code === "ESOCKETTIMEDOUT") return true;

  const message = String(err.message || err).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted due to timeout")
  );
}

/** "45 сек." below two minutes, otherwise whole minutes rounded up: "15 мин.". */
export function formatWaitTime(seconds) {
  const sec = Math.max(1, Math.ceil(Number(seconds) || 0));
  return sec >= 120 ? `${Math.ceil(sec / 60)} мин.` : `${sec} сек.`;
}

export function formatOtpResendCooldownMessage(retryAfterSec) {
  return `Повторный код — через ${formatWaitTime(retryAfterSec)}`;
}

/**
 * A limiter message with the exact wait: "Слишком много попыток входа. Попробуйте позже."
 * becomes "Слишком много попыток входа. Повторите через 14 мин.".
 */
export function formatRateLimitMessage(message, retryAfterSec) {
  const base = String(message || "Слишком много запросов.")
    .replace(/\s*Попробуйте позже\.?\s*$/, "")
    .trim();
  const sentence = /[.!?]$/.test(base) ? base : `${base}.`;
  return `${sentence} Повторите через ${formatWaitTime(retryAfterSec)}`;
}

export function formatTimeoutMessage(timeoutMs = FETCH_TIMEOUT_MS, context) {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const contextPart = context ? ` (${context})` : "";
  return `Превышено время ожидания ответа${contextPart}: ${seconds} сек. Сервер не успел ответить — попробуйте ещё раз через минуту.`;
}

export function publicMessageFromErr(err, fallback, { timeoutMs = FETCH_TIMEOUT_MS, context } = {}) {
  if (isTimeoutError(err)) {
    if (typeof err?.message === "string" && err.message.includes("Превышено время ожидания")) {
      return err.message;
    }
    return formatTimeoutMessage(err?.timeoutMs ?? timeoutMs, context);
  }
  if (typeof err?.publicMessage === "string" && err.publicMessage.trim()) {
    return err.publicMessage;
  }
  return fallback;
}

export function timeoutStatusCode(err) {
  return isTimeoutError(err) ? 504 : 500;
}
