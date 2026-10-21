const FETCH_TIMEOUT_MS = 8000;

/** "45 сек." below two minutes, otherwise whole minutes rounded up: "15 мин.". */
export function formatWaitTime(seconds: number): string {
  const sec = Math.max(1, Math.ceil(Number(seconds) || 0));
  return sec >= 120 ? `${Math.ceil(sec / 60)} мин.` : `${sec} сек.`;
}

export function formatResendCooldownMessage(seconds: number): string {
  return `Повторный код — через ${formatWaitTime(seconds)}`;
}

export function formatResendCooldownButtonLabel(seconds: number): string {
  return `Повторная отправка через ${formatWaitTime(seconds)}`;
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { isTimeout?: boolean; name?: string; code?: string; message?: string };
  if (e.isTimeout === true) return true;
  if (e.name === "TimeoutError") return true;
  if (e.code === "ETIMEDOUT" || e.code === "ESOCKETTIMEDOUT") return true;

  const message = String(e.message || err).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted due to timeout") ||
    message.includes("превышено время ожидания")
  );
}

function formatTimeoutMessage(timeoutMs = FETCH_TIMEOUT_MS, context?: string): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const contextPart = context ? ` (${context})` : "";
  return `Превышено время ожидания ответа${contextPart}: ${seconds} сек. Сервер не успел ответить — попробуйте ещё раз через минуту.`;
}

const EN_TO_RU: Record<string, string> = {
  "Invalid email": "Некорректный email",
  "Invalid request": "Некорректный запрос",
  "Please wait before requesting another code": "Подождите перед повторной отправкой кода",
  "Failed to send code": "Не удалось отправить код",
  "Code expired or not found": "Код истёк или не найден",
  "Too many attempts. Request a new code.": "Слишком много попыток. Запросите новый код.",
  "Invalid code": "Неверный код",
  "Could not complete login": "Не удалось завершить вход",
  Unauthorized: "Требуется авторизация",
  "Session expired": "Сессия истекла",
  "Invalid CSRF token": "Ошибка безопасности. Обновите страницу и попробуйте снова",
  "Failed to load profile": "Не удалось загрузить профиль",
  "Failed to load devices": "Не удалось загрузить устройства",
  "Invalid hwid": "Некорректный идентификатор устройства",
  "Device API not configured": "Сервис устройств временно недоступен",
  "Internal error": "Внутренняя ошибка сервера",
  "Too many requests": "Слишком много запросов. Попробуйте позже.",
  "Too many requests for this email": "Слишком много запросов для этого email. Попробуйте позже.",
  "Too many verification attempts": "Слишком много попыток проверки. Попробуйте позже.",
  "Too many checkout requests": "Слишком много попыток оплаты. Попробуйте позже.",
  "Too many chat requests": "Слишком много запросов к чату. Попробуйте позже.",
  "Too many upload requests": "Слишком много загрузок файлов. Попробуйте позже.",
  "Invalid checkout request": "Некорректный запрос на оплату",
  "Invalid product_key": "Некорректный тариф",
  "Invalid payment_method": "Некорректный способ оплаты",
  "Unsupported payment_method": "Этот способ оплаты не поддерживается",
  "Unsupported product_key": "Этот тариф не поддерживается",
  "Billing redirect URLs misconfigured": "Оплата временно недоступна",
  "Billing not configured": "Оплата временно недоступна",
  "Upstream error": "Сервис оплаты временно недоступен",
  "Checkout failed": "Не удалось создать платёж",
  "Invalid payment URL from upstream": "Получена некорректная ссылка на оплату",
  "Invalid JSON": "Некорректный ответ сервера",
};

function translateKnownMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return trimmed;
  if (/[а-яё]/i.test(trimmed)) return trimmed;

  if (EN_TO_RU[trimmed]) return EN_TO_RU[trimmed];

  const requestFailed = trimmed.match(/^Request failed \((\d+)\)$/);
  if (requestFailed) {
    const status = Number(requestFailed[1]);
    if (status === 504) {
      return formatTimeoutMessage(FETCH_TIMEOUT_MS);
    }
    return `Ошибка запроса (${status})`;
  }

  if (trimmed.startsWith("Talk-Me network error:")) {
    const detail = trimmed.slice("Talk-Me network error:".length).trim();
    if (isTimeoutError({ message: detail })) {
      return formatTimeoutMessage(FETCH_TIMEOUT_MS, "чат поддержки");
    }
    return detail
      ? `Ошибка сети при обращении к чату: ${detail}`
      : "Ошибка сети при обращении к чату";
  }

  if (trimmed.startsWith("Invalid JSON from Talk-Me API")) {
    return "Некорректный ответ от сервера чата";
  }

  return trimmed;
}

export function formatUserError(
  err: unknown,
  fallback: string,
  options?: { timeoutMs?: number; context?: string },
): string {
  if (isTimeoutError(err)) {
    const timeoutMs =
      (err as { timeoutMs?: number })?.timeoutMs ?? options?.timeoutMs ?? FETCH_TIMEOUT_MS;
    const message =
      err instanceof Error && err.message.includes("Превышено время ожидания")
        ? err.message
        : formatTimeoutMessage(timeoutMs, options?.context);
    return message;
  }

  if (err instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(err.message)) {
    return "Не удалось связаться с сервером. Проверьте интернет-соединение и попробуйте снова.";
  }

  const raw = err instanceof Error ? err.message : String(err || "");
  const translated = translateKnownMessage(raw);
  return translated || fallback;
}
