import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Index from "@/pages/Index";
import AdminSetPasswordForm from "@/components/AdminSetPasswordForm";
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
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => vi.fn() };
});

async function openLogin() {
  render(
    <MemoryRouter>
      <Index />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Войти" }));
  return screen.getByLabelText("Email");
}

const sendCodeCalls = () => vi.mocked(apiPost).mock.calls.filter(([path]) => path === "/auth/send-code");

describe("login email typo hint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return { data: { hasPassword: false }, error: null, status: 200 };
      if (path === "/auth/send-code") return { data: { ok: true, retryAfterSec: 30 }, error: null, status: 200 };
      return { data: null, error: null, status: 200 };
    });
  });

  it("does not interrupt the user while typing", async () => {
    const input = await openLogin();
    fireEvent.change(input, { target: { value: "ivan@gmial.com" } });
    expect(screen.queryByTestId("email-typo-hint")).not.toBeInTheDocument();
  });

  it("shows the hint on blur and fixes the email in one tap", async () => {
    const input = await openLogin();
    fireEvent.change(input, { target: { value: "ivan-@gmial.com" } });
    fireEvent.blur(input);

    const hint = screen.getByTestId("email-typo-hint");
    expect(hint).toHaveTextContent("Возможно, вы имели в виду ivan@gmail.com?");
    expect(within(hint).getByText("ivan@gmail.com").tagName).toBe("B");

    fireEvent.click(within(hint).getByRole("button", { name: "Исправить" }));
    expect(input).toHaveValue("ivan@gmail.com");
    expect(screen.queryByTestId("email-typo-hint")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/auth/send-code", { email: "ivan@gmail.com" }));
  });

  it("explains local-part junk and removes it in one tap", async () => {
    const input = await openLogin();
    fireEvent.change(input, { target: { value: "ivan-@gmail.com" } });
    fireEvent.blur(input);

    const hint = screen.getByTestId("email-typo-hint");
    expect(hint).toHaveTextContent("Похоже, в адресе опечатка: лишний «-» перед @");
    fireEvent.click(within(hint).getByRole("button", { name: "Исправить" }));
    expect(input).toHaveValue("ivan@gmail.com");
  });

  it("sends a local-part typo as typed on the second press (server never rejects it)", async () => {
    const input = await openLogin();
    fireEvent.change(input, { target: { value: "ivan-@gmail.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(await screen.findByTestId("email-typo-hint")).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/auth/send-code", { email: "ivan-@gmail.com" }));
  });

  it("holds the first submit to reveal the hint, then sends as typed (non-blocking)", async () => {
    const input = await openLogin();
    fireEvent.change(input, { target: { value: "ivan@mail.ry" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByTestId("email-typo-hint")).toHaveTextContent("ivan@mail.ru");
    expect(apiPost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/auth/send-code", { email: "ivan@mail.ry" }));
  });

  it("never shows a hint for a valid address", async () => {
    const input = await openLogin();
    fireEvent.change(input, { target: { value: "ivan.petrov@mail.com" } });
    fireEvent.blur(input);
    expect(screen.queryByTestId("email-typo-hint")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(sendCodeCalls()).toHaveLength(1));
  });

  it("shows the address on the code screen and goes back to fix it", async () => {
    const input = await openLogin();
    fireEvent.change(input, { target: { value: "ivan@gmail.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));

    expect(await screen.findByRole("heading", { name: "Введите код" })).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    const sentTo = within(dialog).getByText("ivan@gmail.com", { selector: "b" });
    expect(sentTo.closest("p")).toHaveTextContent("Код отправлен на ivan@gmail.com");
    expect(within(dialog).getByText(/Не та почта\?/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Изменить" }));
    expect(await screen.findByRole("heading", { name: "Вход в 220v" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("ivan@gmail.com");
  });
});

describe("admin set-password email typo hint", () => {
  it("suggests a fix for the user's email", () => {
    render(<AdminSetPasswordForm token="t" />);
    const input = screen.getByLabelText("Email пользователя");
    fireEvent.change(input, { target: { value: "user@gmail.ru" } });
    fireEvent.click(screen.getByRole("button", { name: "Исправить" }));
    expect(input).toHaveValue("user@gmail.com");
    expect(screen.queryByTestId("email-typo-hint")).not.toBeInTheDocument();
  });
});
