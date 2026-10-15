import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Chat, { isNearBottom } from "@/pages/Chat";
import { apiPost } from "@/lib/api";

vi.mock("@/hooks/useDashboardSidebarItems", () => ({
  useDashboardSidebarItems: () => ({ email: "user@example.com", items: [], handleLogout: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({ apiBase: "", apiPost: vi.fn(), apiUploadForm: vi.fn() }));
vi.mock("@/lib/talkme", () => ({
  buildTalkMeCustomFields: vi.fn(() => ({})),
  buildTalkMeVisitorName: vi.fn(() => "user"),
  ensureTalkMeScript: vi.fn(),
  setTalkMeClientInfo: vi.fn(),
}));
vi.mock("@/lib/vpnStorage", () => ({ getVpnTalkmeProfileRaw: () => null }));

describe("isNearBottom", () => {
  it("is true only within the threshold of the end of the list", () => {
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 520, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });
});

describe("chat composer on phones", () => {
  let releaseSend: (() => void) | null = null;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({}) }));
    vi.mocked(apiPost).mockImplementation((path: string) => {
      if (path === "/talkme/send") {
        return new Promise((resolve) => {
          releaseSend = () => resolve({ data: {}, error: null, status: 200 });
        });
      }
      return Promise.resolve({ data: {}, error: null, status: 200 });
    });
  });

  afterEach(() => {
    releaseSend?.();
    releaseSend = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const renderChat = () =>
    render(
      <MemoryRouter>
        <Chat />
      </MemoryRouter>,
    );

  it("keeps the textarea enabled while a message is sending so the keyboard stays open", async () => {
    renderChat();
    const textarea = screen.getByPlaceholderText("Опишите вопрос...");
    expect(textarea).toHaveAttribute("enterkeyhint", "send");

    fireEvent.change(textarea, { target: { value: "Привет" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/talkme/send", expect.objectContaining({ text: "Привет" })));
    expect(textarea).not.toBeDisabled();
    expect(textarea).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
  });

  it("does not send on the Enter that confirms an IME composition", () => {
    renderChat();
    const textarea = screen.getByPlaceholderText("Опишите вопрос...");
    fireEvent.change(textarea, { target: { value: "テスト" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(apiPost).not.toHaveBeenCalledWith("/talkme/send", expect.anything());
  });

  it("does not move focus away from the composer when the send button is pressed", () => {
    renderChat();
    fireEvent.change(screen.getByPlaceholderText("Опишите вопрос..."), { target: { value: "Привет" } });
    const sendButton = screen.getByRole("button", { name: "Отправить" });
    expect(sendButton).not.toBeDisabled();
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    sendButton.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
  });
});
