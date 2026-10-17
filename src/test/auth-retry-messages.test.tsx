import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Index from "@/pages/Index";
import PasswordDialog from "@/components/PasswordDialog";
import { apiPost } from "@/lib/api";
import { formatResendCooldownButtonLabel, formatWaitTime } from "@/lib/errorMessages";
import {
  authErrorMessage,
  codeAttemptsFrom,
  codeAttemptsHint,
  rateLimitMessage,
  resendNotice,
} from "@/lib/authMessages";

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

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

const sonner = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: sonner }));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => vi.fn() };
});

type Reply = { data: unknown; error: Error | null; status: number; retryAfterSec?: number };
const ok = (data: Record<string, unknown>): Reply => ({ data, error: null, status: 200 });
const fail = (status: number, data: Record<string, unknown>, retryAfterSec?: number): Reply =>
  ({ data, error: new Error(String(data.error)), status, retryAfterSec });

const toastDescriptions = () => toastMock.mock.calls.map(([arg]) => (arg as { description?: string }).description);

describe("auth retry message helpers", () => {
  it("counts down in seconds for the resend cooldown", () => {
    expect(rateLimitMessage("otp_cooldown", 42)).toBe("Подождите 42 сек. перед повторной отправкой кода");
    expect(formatResendCooldownButtonLabel(41.2)).toBe("Повторная отправка через 42 сек.");
  });

  it("switches to minutes, rounded up, for long limits", () => {
    expect(formatWaitTime(119)).toBe("119 сек.");
    expect(formatWaitTime(120)).toBe("2 мин.");
    expect(formatWaitTime(121)).toBe("3 мин.");
    expect(rateLimitMessage("rate_limited", 840, "Слишком много попыток входа. Попробуйте позже."))
      .toBe("Слишком много попыток входа. Повторите через 14 мин.");
  });

  it("does not repeat a wait the server already put into the message", () => {
    expect(rateLimitMessage("rate_limited", 45, "Слишком много запросов. Повторите через 46 сек."))
      .toBe("Слишком много запросов. Повторите через 45 сек.");
  });

  it("keeps the general text when the wait time is unknown", () => {
    expect(rateLimitMessage("rate_limited", null)).toBe("Слишком много попыток. Попробуйте немного позже.");
    expect(authErrorMessage(fail(429, { error: "Too many requests" }), "x"))
      .toBe("Слишком много попыток. Попробуйте немного позже.");
  });

  it("uses the Retry-After wait when the body has no code", () => {
    expect(authErrorMessage(fail(429, { error: "Слишком много запросов. Попробуйте позже." }, 75), "x"))
      .toBe("Слишком много запросов. Повторите через 75 сек.");
  });

  it("reads attempt counters from a wrong-code answer", () => {
    const attempts = codeAttemptsFrom(fail(400, { error: "Неверный код", attempt: 2, attemptsLeft: 3, maxAttempts: 5 }));
    expect(attempts).toEqual({ attempt: 2, attemptsLeft: 3, maxAttempts: 5 });
    expect(codeAttemptsHint(attempts!)).toBe("Попытка 2 из 5 не подошла. Осталось попыток: 3");
    expect(codeAttemptsFrom(fail(400, { error: "Неверный код" }))).toBeNull();
  });

  it("announces only repeat sends", () => {
    expect(resendNotice(1)).toBe("");
    expect(resendNotice(undefined)).toBe("");
    expect(resendNotice(2)).toBe("Код отправлен повторно (2-я отправка). Проверьте папку «Спам».");
  });
});

describe("login retry messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  const openCodeStep = async () => {
    render(
      <MemoryRouter>
        <Index />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Войти" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@gmail.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await screen.findByRole("heading", { name: "Введите код" });
  };

  it("shows the exact wait from a limiter and holds the resend button", async () => {
    let sends = 0;
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return ok({ hasPassword: false });
      sends += 1;
      return sends === 1 ? ok({ ok: true, retryAfterSec: 1, sendNumber: 1 })
        : fail(429, { error: "Слишком много запросов. Повторите через 7 мин.", code: "rate_limited", retryAfterSec: 420 }, 420);
    });
    await openCodeStep();
    const resend = await screen.findByRole("button", { name: "Отправить код повторно" }, { timeout: 3000 });
    fireEvent.click(resend);
    await waitFor(() => expect(toastDescriptions()).toContain("Слишком много запросов. Повторите через 7 мин."));
    const held = screen.getByRole("button", { name: "Повторная отправка через 7 мин." });
    expect(held).toBeDisabled();
  });

  it("falls back to the general text without a wait", async () => {
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return ok({ hasPassword: false });
      return fail(429, { error: "Too many requests" });
    });
    render(
      <MemoryRouter>
        <Index />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Войти" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@gmail.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(toastDescriptions()).toContain("Слишком много попыток. Попробуйте немного позже."));
  });

  it("shows the attempt number and how many code attempts are left", async () => {
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return ok({ hasPassword: false });
      if (path === "/auth/send-code") return ok({ ok: true, retryAfterSec: 30, sendNumber: 1 });
      return fail(400, { error: "Неверный код. Осталось попыток: 3 из 5", attempt: 2, attemptsLeft: 3, maxAttempts: 5 });
    });
    await openCodeStep();
    expect(screen.queryByRole("status")).toBeNull();
    const input = document.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
    await waitFor(() => expect(toastDescriptions()).toContain("Неверный код. Осталось попыток: 3 из 5"));
    expect(screen.getByRole("status")).toHaveTextContent("Попытка 2 из 5 не подошла. Осталось попыток: 3");
  });

  it("tells the user a repeat code was sent and to check spam", async () => {
    let sends = 0;
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return ok({ hasPassword: false });
      sends += 1;
      return ok({ ok: true, retryAfterSec: 1, sendNumber: sends });
    });
    await openCodeStep();
    expect(toastDescriptions()).toContain("Код подтверждения отправлен на user@gmail.com");
    fireEvent.click(await screen.findByRole("button", { name: "Отправить код повторно" }, { timeout: 3000 }));
    await waitFor(() =>
      expect(toastDescriptions()).toContain("Код отправлен повторно (2-я отправка). Проверьте папку «Спам»."),
    );
  });
});

describe("password dialog retry messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells when the next code can be requested and holds the resend button", async () => {
    vi.mocked(apiPost).mockResolvedValue(
      fail(429, { error: "Подождите 45 сек. перед повторной отправкой кода", code: "otp_cooldown", retryAfterSec: 45 }, 45),
    );
    render(<PasswordDialog open onOpenChange={vi.fn()} hasPassword={false} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Новый пароль"), { target: { value: "abcde1" } });
    fireEvent.change(screen.getByLabelText("Повторите пароль"), { target: { value: "abcde1" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить код" }));
    await waitFor(() => expect(sonner.error).toHaveBeenCalledWith("Подождите 45 сек. перед повторной отправкой кода"));
  });

  it("announces a repeat send", async () => {
    vi.mocked(apiPost).mockResolvedValue(ok({ ok: true, retryAfterSec: 30, sendNumber: 3 }));
    render(<PasswordDialog open onOpenChange={vi.fn()} hasPassword onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Новый пароль"), { target: { value: "abcde1" } });
    fireEvent.change(screen.getByLabelText("Повторите пароль"), { target: { value: "abcde1" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить код" }));
    await waitFor(() =>
      expect(sonner.success).toHaveBeenCalledWith("Код отправлен повторно (3-я отправка). Проверьте папку «Спам»."),
    );
  });
});
