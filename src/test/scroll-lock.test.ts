import { afterEach, expect, it } from "vitest";
import { lockDocumentScroll } from "@/lib/scrollLock";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
});

it("locks html and body and restores the previous styles", () => {
  document.body.style.overflow = "scroll";
  const unlock = lockDocumentScroll();
  expect(document.documentElement.style.overflow).toBe("hidden");
  expect(document.body.style.overflow).toBe("hidden");

  unlock();
  expect(document.documentElement.style.overflow).toBe("");
  expect(document.body.style.overflow).toBe("scroll");
});

it("keeps the page locked until the last nested overlay closes", () => {
  const unlockDrawer = lockDocumentScroll();
  const unlockModal = lockDocumentScroll();

  unlockDrawer();
  unlockDrawer(); // repeated cleanup must not release someone else's lock
  expect(document.body.style.overflow).toBe("hidden");

  unlockModal();
  expect(document.body.style.overflow).toBe("");
});
