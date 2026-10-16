/**
 * Locks page scrolling behind modals, the mobile sidebar drawer and the chat
 * lightbox. Both <html> and <body> get `overflow: hidden` (iOS Safari only
 * honours it reliably on both), plus `overscroll-behavior: none` so the page
 * does not rubber-band behind an open overlay. Locks are reference-counted, so
 * nested overlays restore the original styles only when the last one closes.
 */
const LOCKED_STYLES = { overflow: "hidden", "overscroll-behavior": "none" } as const;

let lockCount = 0;
let saved: Array<{ element: HTMLElement; property: string; value: string }> = [];

export function lockDocumentScroll(): () => void {
  if (typeof document === "undefined") return () => {};

  if (lockCount === 0) {
    saved = [];
    for (const element of [document.documentElement, document.body]) {
      for (const [property, value] of Object.entries(LOCKED_STYLES)) {
        saved.push({ element, property, value: element.style.getPropertyValue(property) });
        element.style.setProperty(property, value);
      }
    }
  }
  lockCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount -= 1;
    if (lockCount > 0) return;
    for (const { element, property, value } of saved) {
      if (value) element.style.setProperty(property, value);
      else element.style.removeProperty(property);
    }
    saved = [];
  };
}
