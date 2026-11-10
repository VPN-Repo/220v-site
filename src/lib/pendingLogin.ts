// Remembers that a login code was just sent, so the code screen comes back after the page reloads
// (people leave the Telegram in-app browser for their mail app and come back to a fresh page).
// Only the address and the send time are kept, never the code; the record lives as long as a code does.

const KEY = "login_pending_v1";
export const PENDING_LOGIN_TTL_MS = 10 * 60_000;

export type PendingLogin = { email: string; sentAt: number };

export function savePendingLogin(email: string, now = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ email, sentAt: now }));
  } catch {
    /* storage blocked: the screen just will not come back */
  }
}

export function readPendingLogin(now = Date.now()): PendingLogin | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingLogin>;
    if (typeof value.email !== "string" || !value.email.includes("@") || typeof value.sentAt !== "number") {
      localStorage.removeItem(KEY);
      return null;
    }
    if (now - value.sentAt > PENDING_LOGIN_TTL_MS || value.sentAt > now + 60_000) {
      localStorage.removeItem(KEY);
      return null;
    }
    return { email: value.email, sentAt: value.sentAt };
  } catch {
    return null;
  }
}

export function clearPendingLogin(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Web inbox of the big Russian and global mail services, for the «Открыть почту» button. */
export function inboxUrlFor(email: string): { url: string; name: string } | null {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") return { url: "https://mail.google.com/mail/u/0/#inbox", name: "Gmail" };
  if (["mail.ru", "inbox.ru", "list.ru", "bk.ru", "internet.ru"].includes(domain)) return { url: "https://e.mail.ru/inbox/", name: "Почту Mail.ru" };
  if (["yandex.ru", "ya.ru", "yandex.com", "yandex.by", "yandex.kz", "narod.ru"].includes(domain)) return { url: "https://mail.yandex.ru/", name: "Яндекс Почту" };
  if (domain === "rambler.ru") return { url: "https://mail.rambler.ru/", name: "Рамблер Почту" };
  if (["outlook.com", "hotmail.com", "live.com"].includes(domain)) return { url: "https://outlook.live.com/mail/", name: "Outlook" };
  if (["icloud.com", "me.com"].includes(domain)) return { url: "https://www.icloud.com/mail", name: "iCloud Почту" };
  return null;
}
