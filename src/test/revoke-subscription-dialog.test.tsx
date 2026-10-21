import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import RevokeSubscriptionDialog from "@/components/RevokeSubscriptionDialog";
import { apiPost } from "@/lib/api";
import { copyText } from "@/lib/clipboard";

vi.mock("@/lib/api", () => ({ apiPost: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const NEW_URL = "https://sub.example/new-link-0123456789abcdef";

describe("revoke subscription dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns prominently before anything is reset", () => {
    render(<RevokeSubscriptionDialog open onOpenChange={vi.fn()} onRevoked={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Выпустить новую ссылку?" })).toBeInTheDocument();
    const warning = screen.getByText("Все ваши устройства сразу потеряют соединение.");
    expect(warning).toHaveClass("dash-modal__warning");
    expect(screen.getByText(/только если ссылка попала к чужим/)).toBeInTheDocument();
    expect(screen.getByText(/пишите в поддержку, новая ссылка тут не поможет/)).toBeInTheDocument();
    expect(screen.getByText(/вставьте новую ссылку в приложение/)).toBeInTheDocument();
    expect(screen.getByText(/Список устройств не очищается/)).toBeInTheDocument();
    expect(screen.getByText(/не чаще 3 раз в час/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("makes cancel the safe default and the confirm button destructive", async () => {
    render(<RevokeSubscriptionDialog open onOpenChange={vi.fn()} onRevoked={vi.fn()} />);
    const cancel = screen.getByRole("button", { name: "Оставить как есть" });
    const confirm = screen.getByRole("button", { name: "Выпустить новую" });
    expect(confirm).toHaveClass("dash-modal-btn--danger");
    expect(confirm).not.toHaveClass("dash-modal-btn--primary");
    expect(cancel).not.toHaveClass("dash-modal-btn--danger");
    await waitFor(() => expect(cancel).toHaveFocus());
  });

  it("cancel closes without calling the API", () => {
    const onOpenChange = vi.fn();
    render(<RevokeSubscriptionDialog open onOpenChange={onOpenChange} onRevoked={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Оставить как есть" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("resets on confirm, shows a toast and the new link with a copy button", async () => {
    const onRevoked = vi.fn();
    const user = { userUuid: "u", subscriptionUrl: NEW_URL };
    vi.mocked(apiPost).mockResolvedValue({
      data: { ok: true, subscriptionUrl: NEW_URL, user },
      error: null,
      status: 200,
    });
    vi.mocked(copyText).mockResolvedValue(true);
    render(<RevokeSubscriptionDialog open onOpenChange={vi.fn()} onRevoked={onRevoked} />);

    fireEvent.click(screen.getByRole("button", { name: "Выпустить новую" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/me/subscription/revoke"));
    expect(await screen.findByRole("heading", { name: "Новая ссылка готова ⚡" })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Новая ссылка готова ⚡", expect.anything());
    expect(onRevoked).toHaveBeenCalledWith({ user, subscriptionUrl: NEW_URL });
    expect(screen.getByLabelText("Новая ссылка подключения")).toHaveValue(NEW_URL);

    fireEvent.click(screen.getByRole("button", { name: "Скопировать ссылку" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(NEW_URL, expect.anything()));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Новая ссылка скопирована"));
  });

  it("shows the server message and stays on the confirmation step on error", async () => {
    vi.mocked(apiPost).mockResolvedValue({
      data: null,
      error: new Error("Ссылку подключения можно обновлять не чаще 3 раз в час. Повторите через 40 мин."),
      status: 429,
    });
    const onRevoked = vi.fn();
    render(<RevokeSubscriptionDialog open onOpenChange={vi.fn()} onRevoked={onRevoked} />);

    fireEvent.click(screen.getByRole("button", { name: "Выпустить новую" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Ссылку подключения можно обновлять не чаще 3 раз в час. Повторите через 40 мин.",
      ),
    );
    expect(onRevoked).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Выпустить новую ссылку?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выпустить новую" })).toBeEnabled();
  });

  it("asks to reload when the new link could not be loaded", async () => {
    vi.mocked(apiPost).mockResolvedValue({
      data: { ok: true, subscriptionUrl: null, user: null, message: "Ссылка обновлена, но новую ссылку не удалось загрузить." },
      error: null,
      status: 200,
    });
    render(<RevokeSubscriptionDialog open onOpenChange={vi.fn()} onRevoked={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Выпустить новую" }));
    expect(await screen.findByText("Ссылка обновлена, но новую ссылку не удалось загрузить.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Скопировать ссылку" })).not.toBeInTheDocument();
  });
});
