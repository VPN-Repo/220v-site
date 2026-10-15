import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  Reflect.deleteProperty(document, "execCommand");
});

it("uses the async Clipboard API when it is available", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  setClipboard({ writeText });
  const execCommand = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

  await expect(copyText("https://example.com/sub")).resolves.toBe(true);
  expect(writeText).toHaveBeenCalledWith("https://example.com/sub");
  expect(execCommand).not.toHaveBeenCalled();
});

it("falls back to execCommand with a read-only 16px field when the API is missing or denied", async () => {
  const button = document.createElement("button");
  document.body.appendChild(button);
  let field: HTMLTextAreaElement | null = null;
  const execCommand = vi.fn(() => {
    field = button.querySelector("textarea");
    return true;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

  setClipboard(undefined);
  await expect(copyText("abc", button)).resolves.toBe(true);
  expect(execCommand).toHaveBeenCalledWith("copy");
  expect(field).not.toBeNull();
  expect(field!.readOnly).toBe(true);
  expect(field!.style.fontSize).toBe("16px");
  expect(button.querySelector("textarea")).toBeNull();

  setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
  await expect(copyText("abc", button)).resolves.toBe(true);
  expect(execCommand).toHaveBeenCalledTimes(2);

  execCommand.mockReturnValue(false);
  await expect(copyText("abc", button)).resolves.toBe(false);
  button.remove();
});
