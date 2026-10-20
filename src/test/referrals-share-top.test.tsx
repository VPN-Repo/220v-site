import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { apiGet } from "@/lib/api";
import Referrals from "@/pages/Referrals";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/useDashboardSidebarItems", () => ({
  useDashboardSidebarItems: () => ({
    email: "user@example.com",
    items: [],
    handleLogout: vi.fn(),
    userUuid: "uuid-123",
    userLoading: false,
  }),
}));

// Not the production values, to prove the page prints what the API sends.
const CONFIG = {
  pointsPerDay: 7,
  registrationPoints: 2,
  firstPaymentPoints: { "1m": 50, "6m": 300, "12m": 900 },
  repeatPaymentPercent: 20,
  available: true,
  eligible: true,
};

let config: Record<string, unknown> = CONFIG;
let pointsBlocked = false;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  config = CONFIG;
  pointsBlocked = false;
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path === "/me/referrals/config") return { data: config, error: null, status: 200 };
    if (path === "/me/referrals/status") {
      return { data: { riskLevel: "none", blocked: false, pointsBlocked }, error: null, status: 200 };
    }
    if (path.startsWith("/me/referrals/points")) {
      return {
        data: { balance: 0, items: [], page: 1, limit: 20, total: 0, total_pages: 0, eligibility: { active: true, reason: null } },
        error: null,
        status: 200,
      };
    }
    if (path === "/me/referrals/exchange-requests") return { data: { items: [] }, error: null, status: 200 };
    return { data: null, error: new Error(path), status: 500 };
  });
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/referrals"]}>
      <Referrals />
    </MemoryRouter>,
  );
}

describe("referral page share block", () => {
  it("puts the link with copy and share buttons above everything else", async () => {
    renderPage();
    const share = await screen.findByTestId("referral-share");
    expect(within(share).getByText(`${window.location.origin}/?ref=uuid-123`)).toBeInTheDocument();
    for (const name of ["Скопировать ссылку", "Поделиться"]) {
      expect(within(share).getByRole("button", { name })).toBeInTheDocument();
    }
    for (const name of ["Telegram", "WhatsApp", "VK"]) {
      expect(within(share).getByRole("link", { name })).toBeInTheDocument();
    }

    const flow = screen.getByRole("region", { name: "Как работает программа" });
    expect(share.compareDocumentPosition(flow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/до 900 баллов за его первую оплату/)).toBeInTheDocument();
    expect(screen.getByText("+2 балла за регистрацию и до +900 баллов за первую оплату тарифа приглашённым другом")).toBeInTheDocument();
  });

  it("is hidden when the program is blocked for the user", async () => {
    config = { ...CONFIG, available: false };
    renderPage();
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/me/referrals/config"));
    await screen.findByRole("button", { name: "Начать" });
    expect(screen.queryByTestId("referral-share")).toBeNull();
  });

  it("shows the rules from the API in the details", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Начать" }));
    fireEvent.click(await screen.findByRole("button", { name: "Подробнее" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("+50 баллов")).toBeInTheDocument();
    expect(within(dialog).getByText("+300 баллов")).toBeInTheDocument();
    expect(within(dialog).getByText("+900 баллов")).toBeInTheDocument();
    expect(within(dialog).getByText("20%")).toBeInTheDocument();
    expect(within(dialog).getByText(/\(10 \/ 60 \/ 180 баллов\)/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/1200/)).toBeNull();
  });

  it("uses the API exchange rate", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Начать" }));
    expect(await screen.findByText(/7 баллов = 1 день\. Призы/)).toBeInTheDocument();
    expect(screen.queryByText(/10 баллов = 1 день/)).toBeNull();
  });
});
