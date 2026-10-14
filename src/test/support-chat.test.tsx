import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { apiGet, apiPost } from "@/lib/api";
import { __resetChatwootStateForTests, type ChatwootApi } from "@/lib/chatwoot";
import {
  buildChatwootAttributes,
  getSupportChatProvider,
  openSupportChat,
  resetSupportChat,
} from "@/lib/supportChat";
import { setVpnTalkmeProfileJson } from "@/lib/vpnStorage";
import Chat from "@/pages/Chat";
import Dashboard from "@/pages/Dashboard";

vi.mock("@/lib/api", () => ({
  apiBase: "/api",
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  apiUploadForm: vi.fn(),
}));
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({
    status: "authed",
    email: "user@example.com",
    user: null,
    error: null,
    refresh: async () => {},
  }),
}));

const USER_UUID = "b6810e6c-8a69-42b1-b298-8b07d8378987";

type TestWindow = Window & {
  $chatwoot?: ChatwootApi;
  TalkMe?: unknown;
  TalkMeSetup?: unknown;
  supportAPIMethod?: unknown;
  chatwootSettings?: Record<string, unknown>;
};
const w = window as TestWindow;

function enableChatwoot() {
  vi.stubEnv("VITE_CHATWOOT_BASE_URL", "https://chat.example.test/");
  vi.stubEnv("VITE_CHATWOOT_WEBSITE_TOKEN", "website-token");
}

function installChatwootApi(): ChatwootApi {
  const api: ChatwootApi = {
    toggle: vi.fn(),
    setUser: vi.fn(),
    setCustomAttributes: vi.fn(),
    reset: vi.fn(),
  };
  w.$chatwoot = api;
  return api;
}

function talkMeCalls(): string[] {
  return vi
    .mocked(apiPost)
    .mock.calls.map(([path]) => path)
    .filter((path) => path.startsWith("/talkme/"));
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/chat" element={<Chat />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/" element={<p>Экран входа</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VITE_CHATWOOT_BASE_URL", "");
  vi.stubEnv("VITE_CHATWOOT_WEBSITE_TOKEN", "");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: null })));
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path === "/chat/identity") {
      return {
        data: { identifier: USER_UUID, identifier_hash: "abc123", email: "user@example.com", name: "user@example.com" },
        error: null,
        status: 200,
      };
    }
    return { data: path === "/me" ? { user: { userUuid: USER_UUID, plan: "1 месяц" } } : {}, error: null, status: 200 };
  });
  vi.mocked(apiPost).mockResolvedValue({ data: {}, error: null, status: 200 });
});

afterEach(() => {
  cleanup();
  resetSupportChat();
  __resetChatwootStateForTests();
  document.getElementById("supportScript")?.remove();
  delete w.$chatwoot;
  delete w.TalkMe;
  delete w.TalkMeSetup;
  delete w.supportAPIMethod;
  delete w.chatwootSettings;
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("support chat provider switch", () => {
  it("uses Talk-Me unless both Chatwoot variables are set", () => {
    expect(getSupportChatProvider()).toBe("talkme");
    vi.stubEnv("VITE_CHATWOOT_BASE_URL", "https://chat.example.test");
    expect(getSupportChatProvider()).toBe("talkme");
    vi.stubEnv("VITE_CHATWOOT_BASE_URL", "");
    vi.stubEnv("VITE_CHATWOOT_WEBSITE_TOKEN", "website-token");
    expect(getSupportChatProvider()).toBe("talkme");
  });

  it("uses Chatwoot when both variables are set", () => {
    enableChatwoot();
    expect(getSupportChatProvider()).toBe("chatwoot");
  });

  it("Chatwoot mode loads the SDK once with the expected settings", () => {
    enableChatwoot();
    openSupportChat();
    openSupportChat();
    const scripts = document.querySelectorAll<HTMLScriptElement>("script#chatwootScript");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe("https://chat.example.test/packs/js/sdk.js");
    expect(w.chatwootSettings).toMatchObject({ hideMessageBubble: true, position: "right", locale: "ru", type: "standard" });
  });

  it("opens the widget after chatwoot:ready with identity and attributes", async () => {
    enableChatwoot();
    setVpnTalkmeProfileJson(JSON.stringify({
      usedTrafficBytes: 25 * 1024 ** 3,
      trafficLimitBytes: 100 * 1024 ** 3,
      currentDevices: 2,
      devicesLimit: 5,
      tariff: "pro_6m",
      expireAt: "2099-01-01T00:00:00Z",
    }));
    const api = installChatwootApi();

    expect(openSupportChat({ email: "user@example.com" })).toBe(true);
    expect(api.toggle).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("chatwoot:ready"));
    expect(api.toggle).toHaveBeenCalledWith("open");

    await waitFor(() => expect(api.setCustomAttributes).toHaveBeenCalled());
    expect(apiGet).toHaveBeenCalledWith("/chat/identity");
    expect(api.setUser).toHaveBeenCalledWith(USER_UUID, {
      email: "user@example.com",
      name: "user@example.com",
      identifier_hash: "abc123",
    });
    expect(api.setCustomAttributes).toHaveBeenCalledWith({
      tariff: "pro_6m",
      devices: "2/5",
      traffic: "25Gb/100Gb",
      expire_at: "2099-01-01T00:00:00Z",
      site: "220v",
    });
  });

  it("calls setUser without identifier_hash when the server has no HMAC token", async () => {
    enableChatwoot();
    vi.mocked(apiGet).mockResolvedValue({
      data: { identifier: USER_UUID, identifier_hash: null, email: "user@example.com", name: "user@example.com" },
      error: null,
      status: 200,
    });
    const api = installChatwootApi();
    openSupportChat({ email: "user@example.com" });
    window.dispatchEvent(new Event("chatwoot:ready"));
    await waitFor(() => expect(api.setUser).toHaveBeenCalled());
    expect(api.setUser).toHaveBeenCalledWith(USER_UUID, { email: "user@example.com", name: "user@example.com" });
  });

  it("builds default custom attributes with site 220v", () => {
    expect(buildChatwootAttributes()).toEqual({ tariff: "—", devices: "0/—", traffic: "0Gb/—", site: "220v" });
  });
});

describe("chat page", () => {
  it("keeps the Talk-Me chat when Chatwoot is off", async () => {
    renderAt("/chat");
    expect(screen.getByRole("heading", { name: "Диалог с оператором" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Открыть чат" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "support@220v.shop" })).toBeInTheDocument();
    await waitFor(() => expect(talkMeCalls()).toContain("/talkme/client-id"));
    expect(document.getElementById("chatwootScript")).toBeNull();
  });

  it("shows the Chatwoot card instead of Talk-Me when Chatwoot is on", async () => {
    enableChatwoot();
    const api = installChatwootApi();
    renderAt("/chat");
    window.dispatchEvent(new Event("chatwoot:ready"));

    expect(screen.getByRole("heading", { name: "Чат с поддержкой" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Предпочтительный способ связи — почта" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Диалог с оператором" })).not.toBeInTheDocument();
    expect(api.toggle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Открыть чат" }));
    expect(api.toggle).toHaveBeenCalledWith("open");

    await waitFor(() => expect(api.setUser).toHaveBeenCalled());
    expect(talkMeCalls()).toEqual([]);
    expect(document.getElementById("supportScript")).toBeNull();
    expect(w.TalkMe).toBeUndefined();
  });
});

describe("logout", () => {
  it("resets Chatwoot from the sidebar logout", async () => {
    enableChatwoot();
    const api = installChatwootApi();
    document.cookie = "cw_conversation=old-conversation; path=/";
    renderAt("/chat");

    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(await screen.findByText("Экран входа")).toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledWith("/auth/logout");
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(document.cookie).not.toContain("cw_conversation=old-conversation");
  });

  it("resets Chatwoot from the dashboard logout", async () => {
    enableChatwoot();
    const api = installChatwootApi();
    renderAt("/dashboard");

    fireEvent.click(await screen.findByRole("button", { name: "Выйти" }));
    expect(await screen.findByText("Экран входа")).toBeInTheDocument();
    expect(api.reset).toHaveBeenCalledTimes(1);
  });

  it("does not touch Chatwoot on logout in Talk-Me mode", async () => {
    const api = installChatwootApi();
    renderAt("/dashboard");
    fireEvent.click(await screen.findByRole("button", { name: "Выйти" }));
    expect(await screen.findByText("Экран входа")).toBeInTheDocument();
    expect(api.reset).not.toHaveBeenCalled();
  });
});
