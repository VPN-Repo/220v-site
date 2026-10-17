import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Index from "@/pages/Index";
import { apiPost } from "@/lib/api";

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

async function openLoginAndEnterEmail(email: string) {
  render(
    <MemoryRouter>
      <Index />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Войти" }));
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
}

describe("login by password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("sends a code as before when the account has no password", async () => {
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return { data: { hasPassword: false }, error: null, status: 200 };
      if (path === "/auth/send-code") return { data: { ok: true, retryAfterSec: 30 }, error: null, status: 200 };
      return { data: null, error: null, status: 200 };
    });

    await openLoginAndEnterEmail("User@Gmail.com");

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/auth/send-code", { email: "user@gmail.com" }));
    expect(apiPost).toHaveBeenCalledWith("/auth/method", { email: "user@gmail.com" });
    expect(await screen.findByRole("heading", { name: "Введите код" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "support@220v.shop" })).toHaveAttribute("href", "mailto:support@220v.shop");
    expect(screen.getByText(/нет доступа к почте/)).toBeInTheDocument();
  });

  it("falls back to the emailed code when the method check fails", async () => {
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return { data: null, error: new Error("Слишком много запросов"), status: 429 };
      if (path === "/auth/send-code") return { data: { ok: true }, error: null, status: 200 };
      return { data: null, error: null, status: 200 };
    });

    await openLoginAndEnterEmail("user@gmail.com");
    expect(await screen.findByRole("heading", { name: "Введите код" })).toBeInTheDocument();
  });

  it("offers password login and sends a code only after choosing email login", async () => {
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return { data: { hasPassword: true }, error: null, status: 200 };
      if (path === "/auth/send-code") return { data: { ok: true }, error: null, status: 200 };
      if (path === "/auth/login-password") return { data: { user: { userUuid: "u" } }, error: null, status: 200 };
      return { data: null, error: null, status: 200 };
    });

    await openLoginAndEnterEmail("user@gmail.com");

    expect(await screen.findByRole("heading", { name: "Введите пароль" })).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalledWith("/auth/send-code", expect.anything());
    const passwordInput = screen.getByLabelText("Пароль");
    expect(passwordInput).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByText(/Забыли пароль и нет доступа к почте/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Задать пароль" })).not.toBeInTheDocument();

    fireEvent.change(passwordInput, { target: { value: "secret1" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Войти" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/auth/login-password", { email: "user@gmail.com", password: "secret1" }),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/dashboard"));
    expect(refresh).toHaveBeenCalled();
  });

  it("switches from the password step to the emailed code", async () => {
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return { data: { hasPassword: true }, error: null, status: 200 };
      if (path === "/auth/send-code") return { data: { ok: true }, error: null, status: 200 };
      return { data: null, error: null, status: 200 };
    });

    await openLoginAndEnterEmail("user@gmail.com");
    fireEvent.click(await screen.findByRole("button", { name: "Войти по коду из email" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/auth/send-code", { email: "user@gmail.com" }));
    expect(await screen.findByRole("heading", { name: "Введите код" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Задать пароль" })).not.toBeInTheDocument();
  });

  it("submits a new password only after two matching entries", async () => {
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return { data: { hasPassword: false }, error: null, status: 200 };
      if (path === "/auth/send-code") return { data: { ok: true }, error: null, status: 200 };
      if (path === "/auth/verify") return { data: { user: { userUuid: "u" } }, error: null, status: 200 };
      return { data: null, error: null, status: 200 };
    });

    await openLoginAndEnterEmail("new@gmail.com");
    fireEvent.click(await screen.findByRole("button", { name: "Задать пароль" }));
    fireEvent.change(screen.getByLabelText("Новый пароль"), { target: { value: "abcde1" } });
    fireEvent.change(screen.getByLabelText("Повторите пароль"), { target: { value: "different1" } });
    const otpInput = document.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
    fireEvent.change(otpInput, { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
    expect(apiPost).not.toHaveBeenCalledWith("/auth/verify", expect.anything());

    fireEvent.change(screen.getByLabelText("Повторите пароль"), { target: { value: "abcde1" } });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/auth/verify", { email: "new@gmail.com", code: "12345", newPassword: "abcde1" }),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/dashboard"));
  });
});
