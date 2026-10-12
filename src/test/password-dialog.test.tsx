import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PasswordDialog from "@/components/PasswordDialog";
import { apiPost } from "@/lib/api";

vi.mock("@/lib/api", () => ({ apiPost: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe("password settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires matching passwords and the emailed code before saving", async () => {
    const onChanged = vi.fn();
    const onOpenChange = vi.fn();
    vi.mocked(apiPost).mockResolvedValue({ data: { ok: true }, error: null, status: 200 });
    render(<PasswordDialog open onOpenChange={onOpenChange} hasPassword={false} onChanged={onChanged} />);

    expect(screen.getByRole("heading", { name: "Задать пароль" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "support@220v.shop" })).toHaveAttribute("href", "mailto:support@220v.shop");

    const passwordInputs = [screen.getByLabelText("Новый пароль"), screen.getByLabelText("Повторите пароль")];
    const visibilityButtons = screen.getAllByRole("button", { name: "Показать пароль" });
    expect(visibilityButtons).toHaveLength(2);
    expect(passwordInputs.every((input) => input.getAttribute("type") === "password")).toBe(true);
    fireEvent.click(visibilityButtons[0]);
    expect(passwordInputs.every((input) => input.getAttribute("type") === "text")).toBe(true);

    fireEvent.change(screen.getByLabelText("Новый пароль"), { target: { value: "abcde1" } });
    fireEvent.change(screen.getByLabelText("Повторите пароль"), { target: { value: "different-password1" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить код" }));
    expect(apiPost).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Повторите пароль"), { target: { value: "abcde1" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить код" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/auth/password/send-code", {}));
    fireEvent.change(await screen.findByLabelText("Код из email"), { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить пароль" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/auth/password/change", { code: "12345", newPassword: "abcde1" }),
    );
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("offers to change an existing password", () => {
    render(<PasswordDialog open onOpenChange={vi.fn()} hasPassword onChanged={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Сменить пароль" })).toBeInTheDocument();
  });
});
