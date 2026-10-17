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

  it("explains the consequences before anything is revoked", () => {
    render(<RevokeSubscriptionDialog open onOpenChange={vi.fn()} onRevoked={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Обновить ссылку подключения?" })).toBeInTheDocument();
    expect(screen.getByText(/ссылка попала к посторонним или кто-то чужой пользуется/)).toBeInTheDocument();
    expect(screen.getByText(/Старая ссылка перестанет работать/)).toBeInTheDocument();
    expect(screen.getByText(/сразу на всех устройствах/)).toBeInTheDocument();
    expect(screen.getByText(/вставьте новую ссылку в приложение/)).toBeInTheDocument();
    expect(screen.getByText(/Список устройств не очищается/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("cancel closes without calling the API", () => {
    const onOpenChange = vi.fn();
    render(<RevokeSubscriptionDialog open onOpenChange={onOpenChange} onRevoked={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("revokes on confirm, shows a toast and the new link with a copy button", async () => {
    const onRevoked = vi.fn();
    const user = { userUuid: "u", subscriptionUrl: NEW_URL };
    vi.mocked(apiPost).mockResolvedValue({
      data: { ok: true, subscriptionUrl: NEW_URL, user },
      error: null,
      status: 200,
    });
    vi.mocked(copyText).mockResolvedValue(true);
    render(<RevokeSubscriptionDialog open onOpenChange={vi.fn()} onRevoked={onRevoked} />);

    fireEvent.click(screen.getByRole("button", { name: "Обновить ссылку" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/me/subscription/revoke"));
    expect(await screen.findByRole("heading", { name: "Ссылка обновлена" })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Ссылка подключения обновлена", expect.anything());
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

    fireEvent.click(screen.getByRole("button", { name: "Обновить ссылку" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Ссылку подключения можно обновлять не чаще 3 раз в час. Повторите через 40 мин.",
      ),
    );
    expect(onRevoked).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Обновить ссылку подключения?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Обновить ссылку" })).toBeEnabled();
  });

  it("asks to reload when the new link could not be loaded", async () => {
    vi.mocked(apiPost).mockResolvedValue({
      data: { ok: true, subscriptionUrl: null, user: null, message: "Ссылка обновлена, но новую ссылку не удалось загрузить." },
      error: null,
      status: 200,
    });
    render(<RevokeSubscriptionDialog open onOpenChange={vi.fn()} onRevoked={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Обновить ссылку" }));
    expect(await screen.findByText("Ссылка обновлена, но новую ссылку не удалось загрузить.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Скопировать ссылку" })).not.toBeInTheDocument();
  });
});
