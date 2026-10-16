/**
 * Copies text from a user gesture. Prefers the async Clipboard API and falls
 * back to a temporary read-only field + `execCommand("copy")`, which still
 * works in older iOS Safari and Android WebViews. The fallback field uses a
 * 16px font so iOS does not zoom, and `readOnly` so no keyboard pops up.
 */
function copyViaExecCommand(text: string, container?: HTMLElement | null): boolean {
  if (typeof document === "undefined") return false;
  const host = container ?? document.body;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.position = "absolute";
  field.style.opacity = "0";
  field.style.height = "0";
  field.style.width = "1px";
  field.style.fontSize = "16px";
  field.style.pointerEvents = "none";
  host.appendChild(field);

  let ok = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    host.removeChild(field);
  }
  return ok;
}

export async function copyText(text: string, container?: HTMLElement | null): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or insecure context — use the legacy path below.
    }
  }
  return copyViaExecCommand(text, container);
}
