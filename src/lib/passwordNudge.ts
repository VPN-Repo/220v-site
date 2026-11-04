const DISMISSED_KEY = "v220_password_nudge_dismissed_at";
// После × плашка не показывается 30 дней.
const DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

export function isPasswordNudgeDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < DISMISS_MS;
  } catch {
    return false;
  }
}

export function dismissPasswordNudge() {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
  } catch {
    // без хранилища плашка просто вернётся при следующем входе
  }
}
