import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Index from "@/pages/Index";
import { apiGet, apiPost } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  apiBase: "/api",
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const refresh = vi.fn(async () => undefined);
vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ refresh }) }));
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => vi.fn() };
});

const MAILBOX_FULL = {
  category: "mailbox_full",
  message: "Ящик забит под завязку — освободите место и запросите код заново.",
};
const INVALID = {
  category: "invalid_address",
  message: "Почтовый ящик не найден. Проверьте адрес на опечатки.",
};

let deliveryStatusWarning: typeof INVALID | null = null;
const statusCalls = () => vi.mocked(apiGet).mock.calls.filter(([path]) => path.startsWith("/auth/delivery-status"));

async function sendCodeFor(email: string) {
  render(
    <MemoryRouter>
      <Index />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Войти" }));
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
  expect(await screen.findByRole("heading", { name: "Введите код" })).toBeInTheDocument();
  return screen.getByRole("dialog");
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("login code screen delivery warning", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    deliveryStatusWarning = null;
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path === "/me") return { data: null, error: new Error("Требуется авторизация"), status: 401 };
      if (path.startsWith("/auth/delivery-status")) {
        return { data: { warning: deliveryStatusWarning }, error: null, status: 200 };
      }
      return { data: null, error: null, status: 200 };
    });
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return { data: { hasPassword: false }, error: null, status: 200 };
      if (path === "/auth/send-code") return { data: { ok: true, retryAfterSec: 30 }, error: null, status: 200 };
      return { data: null, error: null, status: 200 };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows deliveryWarning from send-code with a way to change the address", async () => {
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return { data: { hasPassword: false }, error: null, status: 200 };
      if (path === "/auth/send-code") {
        return { data: { ok: true, retryAfterSec: 30, deliveryWarning: MAILBOX_FULL }, error: null, status: 200 };
      }
      return { data: null, error: null, status: 200 };
    });
    const dialog = await sendCodeFor("ivan@gmail.com");
    const warning = within(dialog).getByTestId("delivery-warning");
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent(MAILBOX_FULL.message);

    fireEvent.click(within(warning).getByRole("button", { name: "Изменить почту" }));
    expect(await screen.findByRole("heading", { name: "Вход в 220v" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("ivan@gmail.com");
    expect(screen.queryByTestId("delivery-warning")).not.toBeInTheDocument();
  });

  it("polls delivery-status every 10 s and shows a bounce that arrives later", async () => {
    const dialog = await sendCodeFor("ivan@gmail.com");
    expect(within(dialog).queryByTestId("delivery-warning")).not.toBeInTheDocument();
    expect(statusCalls()).toHaveLength(0);

    await advance(10_000);
    expect(statusCalls()).toHaveLength(1);
    expect(statusCalls()[0][0]).toBe("/auth/delivery-status?email=ivan%40gmail.com");

    deliveryStatusWarning = INVALID;
    await advance(10_000);
    expect(statusCalls()).toHaveLength(2);
    expect(within(dialog).getByTestId("delivery-warning")).toHaveTextContent(INVALID.message);

    // A warning ends the polling.
    await advance(60_000);
    expect(statusCalls()).toHaveLength(2);
  });

  it("stops polling after 2 minutes", async () => {
    await sendCodeFor("ivan@gmail.com");
    await advance(5 * 60_000);
    expect(statusCalls()).toHaveLength(12);
  });

  it("stops polling when the code screen closes", async () => {
    const dialog = await sendCodeFor("ivan@gmail.com");
    await advance(10_000);
    expect(statusCalls()).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Исправить" }));
    await advance(60_000);
    expect(statusCalls()).toHaveLength(1);
  });
});
