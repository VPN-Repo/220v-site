import type { ApiResult } from "@/lib/api";
import { formatResendCooldownMessage, formatWaitTime } from "@/lib/errorMessages";

/** Fields the auth API adds to 429 and wrong-code answers. */
export type AuthErrorBody = {
  error?: string;
  code?: string;
  retryAfterSec?: number;
  attempt?: number;
  attemptsLeft?: number;
  maxAttempts?: number;
};

export const RATE_LIMIT_FALLBACK = "Слишком много попыток. Попробуйте немного позже.";

const CYRILLIC_RE = /[А-Яа-яЁё]/;

function bodyOf(result: Pick<ApiResult<unknown>, "data">): AuthErrorBody | null {
  const data = result.data;
  return data && typeof data === "object" ? (data as AuthErrorBody) : null;
}

/**
 * The text for a 429 answer with the exact wait: the OTP cooldown says when a new code can be
 * requested, a limiter keeps its own message and ends with "Повторите через 14 мин.".
 */
export function rateLimitMessage(code: string | undefined, retryAfterSec: number | null | undefined,
  serverMessage?: string): string {
  const message = serverMessage && CYRILLIC_RE.test(serverMessage) ? serverMessage.trim() : "";
  if (!retryAfterSec || retryAfterSec <= 0) return message || RATE_LIMIT_FALLBACK;
  if (code === "otp_cooldown") return formatResendCooldownMessage(retryAfterSec);
  const base = (message || "Слишком много попыток.")
    .replace(/\s*(Попробуйте позже|Попробуйте немного позже|Повторите через .*)\.?\s*$/, "")
    .trim();
  const sentence = /[.!?]$/.test(base) ? base : `${base}.`;
  return `${sentence} Повторите через ${formatWaitTime(retryAfterSec)}`;
}

/** The user-facing text for a failed auth request; a 429 always tells when to retry. */
export function authErrorMessage(
  result: Pick<ApiResult<unknown>, "data" | "error" | "status" | "retryAfterSec">,
  fallback: string,
): string {
  const body = bodyOf(result);
  if (result.status === 429) {
    return rateLimitMessage(body?.code, result.retryAfterSec ?? body?.retryAfterSec, body?.error ?? result.error?.message);
  }
  return result.error?.message || body?.error || fallback;
}

export type CodeAttempts = { attempt: number; attemptsLeft: number; maxAttempts: number };

/** Attempt counters from a wrong-code answer, or null when the server sent none. */
export function codeAttemptsFrom(result: Pick<ApiResult<unknown>, "data">): CodeAttempts | null {
  const body = bodyOf(result);
  const attemptsLeft = Number(body?.attemptsLeft);
  const maxAttempts = Number(body?.maxAttempts);
  if (!Number.isInteger(attemptsLeft) || !Number.isInteger(maxAttempts) || maxAttempts <= 0) return null;
  const attempt = Number.isInteger(Number(body?.attempt)) ? Number(body?.attempt) : maxAttempts - attemptsLeft;
  return { attempt, attemptsLeft, maxAttempts };
}

/** Line under the code input after a wrong code. */
export function codeAttemptsHint({ attempt, attemptsLeft, maxAttempts }: CodeAttempts): string {
  return `Попытка ${attempt} из ${maxAttempts} не подошла. Осталось попыток: ${attemptsLeft}`;
}

/** Notice after a repeat send; the first send keeps the usual text. */
export function resendNotice(sendNumber: unknown): string {
  const n = Number(sendNumber);
  if (!Number.isInteger(n) || n < 2) return "";
  return `Код отправлен повторно (${n}-я отправка). Проверьте папку «Спам».`;
}
