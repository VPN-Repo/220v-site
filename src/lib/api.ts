import { formatUserError } from "./errorMessages";

export const apiBase =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "/api";

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)v220_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export type ApiResult<T> = { data: T | null; error: Error | null; status: number; retryAfterSec?: number };

function readRetryAfterSec(res: Response, parsed: unknown): number | undefined {
  if (typeof parsed === "object" && parsed !== null && "retryAfterSec" in parsed) {
    const value = Number((parsed as { retryAfterSec: unknown }).retryAfterSec);
    if (Number.isFinite(value) && value > 0) {
      return Math.ceil(value);
    }
  }

  const header = res.headers.get("Retry-After");
  if (header) {
    const value = Number(header);
    if (Number.isFinite(value) && value > 0) {
      return Math.ceil(value);
    }
  }

  return undefined;
}

async function parseResponse<T>(res: Response): Promise<ApiResult<T>> {
  let parsed: unknown;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text || "Некорректный ответ сервера" };
  }

  const data = parsed as T | null;
  const retryAfterSec = readRetryAfterSec(res, parsed);

  if (!res.ok) {
    const msg =
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
        ? formatUserError(
            new Error((parsed as { error: string }).error),
            `Ошибка запроса (${res.status})`,
          )
        : formatUserError(null, `Ошибка запроса (${res.status})`);
    return { data, error: new Error(msg), status: res.status, retryAfterSec };
  }

  return { data, error: null, status: res.status, retryAfterSec };
}

async function apiFetch<T>(
  path: string,
  init: RequestInit & { method?: string } = {},
): Promise<ApiResult<T>> {
  const method = (init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD") {
    const csrf = getCsrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }

  try {
    const res = await fetch(`${apiBase}${path}`, {
      ...init,
      method,
      headers,
      credentials: "include",
    });

    return parseResponse<T>(res);
  } catch (err) {
    const message = formatUserError(err, "Не удалось выполнить запрос");
    return { data: null, error: new Error(message), status: 0 };
  }
}

export function apiGet<T>(path: string) {
  return apiFetch<T>(path, { method: "GET" });
}

export function apiPost<T>(path: string, body?: Record<string, unknown>) {
  return apiFetch<T>(path, {
    method: "POST",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function apiDelete<T>(path: string) {
  return apiFetch<T>(path, { method: "DELETE" });
}

export function apiUploadForm<T>(path: string, formData: FormData) {
  return apiFetch<T>(path, {
    method: "POST",
    body: formData,
  });
}
