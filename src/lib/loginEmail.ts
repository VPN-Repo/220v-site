// Почта последнего успешного входа: при следующем открытии окна входа поле уже заполнено.
const LAST_LOGIN_EMAIL_KEY = "v220_last_login_email";

export function readLastLoginEmail(): string {
  try {
    return localStorage.getItem(LAST_LOGIN_EMAIL_KEY) || "";
  } catch {
    return "";
  }
}

export function rememberLoginEmail(email: string) {
  try {
    if (email) localStorage.setItem(LAST_LOGIN_EMAIL_KEY, email.trim().toLowerCase());
  } catch {
    // приватный режим или запрет хранилища — просто не запоминаем
  }
}
