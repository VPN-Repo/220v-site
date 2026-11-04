// Токен ссылки «Войти» из письма приходит во фрагменте адреса (#login=...):
// фрагмент не уходит на сервер и в Referer. Модуль импортируется первым в main.tsx,
// забирает токен до запуска остального кода и сразу убирает его из адреса и истории.
const LOGIN_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

let pendingToken: string | null = null;

export function captureLoginLinkToken(location: Location = window.location, history: History = window.history) {
  try {
    const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const token = params.get("login");
    if (token === null) return;
    params.delete("login");
    const rest = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
    pendingToken = LOGIN_TOKEN_RE.test(token) ? token : null;
  } catch {
    pendingToken = null;
  }
}

export function getLoginLinkToken(): string | null {
  return pendingToken;
}

export function clearLoginLinkToken() {
  pendingToken = null;
}

captureLoginLinkToken();
