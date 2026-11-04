import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Index from "@/pages/Index";
import { apiPost } from "@/lib/api";
import { captureLoginLinkToken, clearLoginLinkToken, getLoginLinkToken } from "@/lib/loginLink";

vi.mock("@/lib/api", () => ({
  apiBase: "/api",
  apiGet: vi.fn(async (path: string) => {
    if (path === "/me") return { data: null, error: new Error("Требуется авторизация"), status: 401 };
    return { data: null, error: null, status: 200 };
  }),
  apiPost: vi.fn(),
}));

const refresh = vi.fn(async () => undefined);
vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ refresh }) }));

const navigateMock = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateMock };
});

const TOKEN = "linkTokenAbcdefghijklmnop_123";

function openWithLink(token = TOKEN) {
  window.history.replaceState(null, "", `/#login=${token}`);
  captureLoginLinkToken();
  render(
    <MemoryRouter>
      <Index />
    </MemoryRouter>,
  );
}

describe("login by the emailed link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    clearLoginLinkToken();
  });

  it("removes the token from the address before anything else runs", () => {
    window.history.replaceState(null, "", `/?ref=1#login=${TOKEN}`);
    captureLoginLinkToken();
    expect(getLoginLinkToken()).toBe(TOKEN);
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?ref=1");
  });

  it("ignores a malformed token but still cleans the address", () => {
    window.history.replaceState(null, "", "/#login=<script>");
    captureLoginLinkToken();
    expect(getLoginLinkToken()).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("asks whose account it is and logs in only after the click", async () => {
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/link-info") return { data: { maskedEmail: "iv***@gmail.com" }, error: null, status: 200 };
      if (path === "/auth/verify-link") {
        return { data: { user: { userUuid: "u" }, loginEmail: "ivan@gmail.com" }, error: null, status: 200 };
      }
      return { data: null, error: null, status: 200 };
    });
    openWithLink();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("iv***@gmail.com")).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalledWith("/auth/verify-link", expect.anything());

    fireEvent.click(within(dialog).getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/auth/verify-link", { token: TOKEN }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/dashboard", { replace: true }));
    expect(localStorage.getItem("v220_last_login_email")).toBe("ivan@gmail.com");
    expect(getLoginLinkToken()).toBeNull();
  });

  it("does not use the link when the visitor says it is not their account", async () => {
    vi.mocked(apiPost).mockResolvedValue({ data: { maskedEmail: "iv***@gmail.com" }, error: null, status: 200 });
    openWithLink();

    fireEvent.click(await screen.findByRole("button", { name: "Это не мой аккаунт" }));
    await waitFor(() => expect(screen.queryByText("iv***@gmail.com")).not.toBeInTheDocument());
    expect(apiPost).not.toHaveBeenCalledWith("/auth/verify-link", expect.anything());
    expect(getLoginLinkToken()).toBeNull();
  });

  it("opens the usual login when the link is out of date", async () => {
    vi.mocked(apiPost).mockResolvedValue({
      data: { error: "Ссылка устарела или уже использована. Запросите новый код" },
      error: new Error("Ссылка устарела или уже использована. Запросите новый код"),
      status: 400,
    });
    openWithLink();

    expect(await screen.findByRole("heading", { name: "Вход в 220v" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalledWith("/auth/verify-link", expect.anything());
  });
});
