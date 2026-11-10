// Site funnel events (see api/funnel.mjs). The same file is copied unchanged into every brand site.
// The browser keeps a random visitor id in localStorage so the server can count distinct visitors;
// nothing else about the visitor is sent.

export type FunnelEvent =
  | "landing_view"
  | "landing_cta"
  | "login_open"
  | "dashboard_view"
  | "instructions_open"
  | "install_click"
  | "add_click"
  | "copy_link"
  | "qr_open"
  | "device_connected"
  | "buy_open"
  | "checkout_click"
  | "pay_success_view"
  | "pay_fail_view"
  | "support_open";

const VISITOR_KEY = "funnel_vid";
let memoryVisitor = "";
const sentOnce = new Set<string>();

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function visitorId(): string {
  try {
    const stored = localStorage.getItem(VISITOR_KEY);
    if (stored && /^[A-Za-z0-9_-]{16,64}$/.test(stored)) return stored;
    const id = randomId();
    localStorage.setItem(VISITOR_KEY, id);
    return id;
  } catch {
    if (!memoryVisitor) memoryVisitor = randomId();
    return memoryVisitor;
  }
}

/**
 * Sends one funnel event. Never throws and never blocks the page.
 * `once`: send it at most once per page load (screen views re-rendered by React).
 */
export function track(event: FunnelEvent, { once = false }: { once?: boolean } = {}): void {
  try {
    if (once) {
      if (sentOnce.has(event)) return;
      sentOnce.add(event);
    }
    const body = JSON.stringify({ e: event, v: visitorId() });
    const blob = new Blob([body], { type: "application/json" });
    if (typeof navigator !== "undefined" && navigator.sendBeacon?.("/api/events", blob)) return;
    void fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    // Analytics must never break the site.
  }
}
