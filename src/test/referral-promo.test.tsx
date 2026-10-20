import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { toast } from "sonner";

import { apiGet } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import {
  REFERRAL_PROMO_DISMISS_KEY,
  REFERRAL_PROMO_DISMISS_TTL_MS,
  buildReferralLink,
  dismissReferralPromo,
  isReferralPromoDismissed,
  maxFirstPaymentPoints,
  parseReferralConfig,
  pluralPoints,
  referralShareTargets,
  referralShareText,
  repeatTierPoints,
} from "@/lib/referralPromo";
import ReferralPromoStrip, { REFERRAL_PROMO_SHORT_TEXT } from "@/components/ReferralPromoStrip";
import ReferralShare from "@/components/ReferralShare";
import PaySuccess, { PAY_SUCCESS_REFERRAL_TITLE } from "@/pages/PaySuccess";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const session = vi.hoisted(() => ({
  value: { status: "authed", user: { userUuid: "uuid-123" } as { userUuid?: string } | null },
}));
vi.mock("@/hooks/useSession", () => ({ useSession: () => session.value }));

const LINK = "https://220v.test/?ref=uuid-123";

// Deliberately not the production numbers: the UI must print whatever the API sends.
const CONFIG = {
  pointsPerDay: 7,
  registrationPoints: 2,
  firstPaymentPoints: { "1m": 50, "6m": 300, "12m": 900 },
  repeatPaymentPercent: 20,
  available: true,
  eligible: true,
};

function mockConfig(config: unknown, error: Error | null = null) {
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path === "/me/referrals/config") return { data: error ? null : config, error, status: error ? 500 : 200 };
    return { data: null, error: new Error(`unexpected ${path}`), status: 500 };
  });
}

function renderStrip() {
  return render(
    <MemoryRouter>
      <ReferralPromoStrip />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  session.value = { status: "authed", user: { userUuid: "uuid-123" } };
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "share");
});

describe("referral promo helpers", () => {
  it("parses the API config and drops invalid values", () => {
    expect(parseReferralConfig(CONFIG)).toEqual(CONFIG);
    expect(parseReferralConfig({ ...CONFIG, pointsPerDay: 0 })).toBeNull();
    expect(parseReferralConfig(null)).toBeNull();
    const parsed = parseReferralConfig({ pointsPerDay: 10, firstPaymentPoints: { "1m": "x", "6m": 600 } });
    expect(parsed?.firstPaymentPoints).toEqual({ "6m": 600 });
    expect(parsed?.available).toBe(false);
    expect(parsed?.eligible).toBeNull();
  });

  it("derives the headline numbers from the config", () => {
    const config = parseReferralConfig(CONFIG);
    expect(maxFirstPaymentPoints(config)).toBe(900);
    expect(repeatTierPoints(config, "6m")).toBe(60);
    expect(maxFirstPaymentPoints(null)).toBeNull();
  });

  it("pluralises points in Russian", () => {
    expect(pluralPoints(1)).toBe("балл");
    expect(pluralPoints(3)).toBe("балла");
    expect(pluralPoints(10)).toBe("баллов");
    expect(pluralPoints(12)).toBe("баллов");
    expect(pluralPoints(1200)).toBe("баллов");
  });

  it("builds the referral link and the ready-made message", () => {
    expect(buildReferralLink("https://220v.test", "uuid-123")).toBe(LINK);
    expect(buildReferralLink("https://220v.test", null)).toBe("");
    expect(referralShareText(LINK)).toBe(
      `Пользуюсь 220 Вольт — всё работает быстро и стабильно. Попробуй по моей ссылке: ${LINK}`,
    );
  });

  it("keeps the banned service word out of anything a user shares", () => {
    const shared = [referralShareText(LINK), ...referralShareTargets(LINK).map((t) => decodeURIComponent(t.href))];
    for (const text of shared) expect(text).not.toMatch(/vpn|впн/i);
  });

  it("builds one-tap share URLs with the link encoded", () => {
    const targets = Object.fromEntries(referralShareTargets(LINK).map((t) => [t.key, new URL(t.href)]));
    expect(targets.telegram.origin + targets.telegram.pathname).toBe("https://t.me/share/url");
    expect(targets.telegram.searchParams.get("url")).toBe(LINK);
    expect(targets.telegram.searchParams.get("text")).toContain("Пользуюсь 220 Вольт — всё работает");
    expect(targets.whatsapp.origin).toBe("https://wa.me");
    expect(targets.whatsapp.searchParams.get("text")).toBe(referralShareText(LINK));
    expect(targets.vk.origin + targets.vk.pathname).toBe("https://vk.com/share.php");
    expect(targets.vk.searchParams.get("url")).toBe(LINK);
  });

  it("keeps the dismissal for 14 days only", () => {
    const now = 1_700_000_000_000;
    expect(isReferralPromoDismissed(now)).toBe(false);
    dismissReferralPromo(now);
    expect(isReferralPromoDismissed(now + REFERRAL_PROMO_DISMISS_TTL_MS - 1)).toBe(true);
    expect(isReferralPromoDismissed(now + REFERRAL_PROMO_DISMISS_TTL_MS + 1)).toBe(false);
    expect(localStorage.getItem(REFERRAL_PROMO_DISMISS_KEY)).toBeNull();
  });
});

describe("dashboard referral strip", () => {
  it("shows the full and short copy with numbers from the API and links to /referrals", async () => {
    mockConfig(CONFIG);
    renderStrip();
    const strip = await screen.findByTestId("referral-promo");
    expect(
      within(strip).getByText(
        "Хотите пользоваться бесплатно? Пригласите друга — до 900 баллов за его оплату, 7 баллов = 1 день подписки",
      ),
    ).toBeInTheDocument();
    expect(within(strip).getByText(REFERRAL_PROMO_SHORT_TEXT)).toHaveClass("ref-promo__text--short");
    expect(within(strip).getByText("Пригласить")).toHaveClass("ref-promo__pill");
  });

  it("opens the referral page from the pill", async () => {
    mockConfig(CONFIG);
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/dashboard" element={<ReferralPromoStrip />} />
          <Route path="/referrals" element={<p>referrals page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText("Пригласить"));
    expect(await screen.findByText("referrals page")).toBeInTheDocument();
  });

  it("falls back to the short copy when the API sends no tiers", async () => {
    mockConfig({ ...CONFIG, firstPaymentPoints: {} });
    renderStrip();
    const strip = await screen.findByTestId("referral-promo");
    expect(within(strip).getByText(REFERRAL_PROMO_SHORT_TEXT)).not.toHaveClass("ref-promo__text--short");
    expect(within(strip).queryByText(/до \d+ баллов/)).toBeNull();
  });

  it.each([
    ["blocked", { ...CONFIG, available: false }],
    ["without an active paid tariff", { ...CONFIG, eligible: false }],
  ])("stays hidden when the program is %s", async (_label, config) => {
    mockConfig(config);
    renderStrip();
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/me/referrals/config"));
    await Promise.resolve();
    expect(screen.queryByTestId("referral-promo")).toBeNull();
  });

  it("stays hidden when the config request fails", async () => {
    mockConfig(null, new Error("down"));
    renderStrip();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.queryByTestId("referral-promo")).toBeNull();
  });

  it("shows when eligibility is unknown", async () => {
    mockConfig({ ...CONFIG, eligible: null });
    renderStrip();
    expect(await screen.findByTestId("referral-promo")).toBeInTheDocument();
  });

  it("hides on × for 14 days and skips the request meanwhile", async () => {
    mockConfig(CONFIG);
    const first = renderStrip();
    fireEvent.click(await screen.findByRole("button", { name: "Скрыть на 14 дней" }));
    expect(screen.queryByTestId("referral-promo")).toBeNull();
    expect(Number(localStorage.getItem(REFERRAL_PROMO_DISMISS_KEY))).toBeGreaterThan(0);
    first.unmount();

    vi.mocked(apiGet).mockClear();
    renderStrip();
    expect(screen.queryByTestId("referral-promo")).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("comes back once the 14 days have passed", async () => {
    localStorage.setItem(REFERRAL_PROMO_DISMISS_KEY, String(Date.now() - REFERRAL_PROMO_DISMISS_TTL_MS - 1000));
    mockConfig(CONFIG);
    renderStrip();
    expect(await screen.findByTestId("referral-promo")).toBeInTheDocument();
  });
});

describe("referral share block", () => {
  it("copies the link", async () => {
    vi.mocked(copyText).mockResolvedValue(true);
    render(<ReferralShare link={LINK} showLink />);
    expect(screen.getByText(LINK)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Скопировать ссылку" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(LINK, expect.anything()));
    expect(toast.success).toHaveBeenCalledWith("Ссылка скопирована!");
    expect(await screen.findByRole("button", { name: "Скопировано" })).toBeInTheDocument();
  });

  it("shows the link in an error toast when copying fails", async () => {
    vi.mocked(copyText).mockResolvedValue(false);
    render(<ReferralShare link={LINK} />);
    fireEvent.click(screen.getByRole("button", { name: "Скопировать ссылку" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ description: LINK })),
    );
  });

  it("opens the native share sheet when available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    render(<ReferralShare link={LINK} />);
    fireEvent.click(screen.getByRole("button", { name: "Поделиться" }));
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: LINK })));
    expect(copyText).not.toHaveBeenCalled();
  });

  it("does not copy when the user closes the share sheet", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("closed", "AbortError"));
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    render(<ReferralShare link={LINK} />);
    fireEvent.click(screen.getByRole("button", { name: "Поделиться" }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(copyText).not.toHaveBeenCalled();
  });

  it("copies the ready message when native share is missing", async () => {
    vi.mocked(copyText).mockResolvedValue(true);
    render(<ReferralShare link={LINK} />);
    fireEvent.click(screen.getByRole("button", { name: "Поделиться" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(referralShareText(LINK), expect.anything()));
  });

  it("renders Telegram, WhatsApp and VK links that open in a new tab", () => {
    render(<ReferralShare link={LINK} />);
    for (const name of ["Telegram", "WhatsApp", "VK"]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
    expect(screen.getByRole("link", { name: "Telegram" }).getAttribute("href")).toMatch(/^https:\/\/t\.me\/share\/url\?url=/);
  });
});

describe("pay success referral card", () => {
  function renderPaySuccess() {
    return render(
      <MemoryRouter>
        <PaySuccess />
      </MemoryRouter>,
    );
  }

  it("invites to share after a payment", async () => {
    mockConfig(CONFIG);
    renderPaySuccess();
    const card = await screen.findByTestId("pay-success-referral");
    expect(within(card).getByRole("heading", { name: PAY_SUCCESS_REFERRAL_TITLE })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Скопировать ссылку" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Поделиться" })).toBeInTheDocument();
    const telegram = within(card).getByRole("link", { name: "Telegram" });
    expect(new URL(telegram.getAttribute("href") as string).searchParams.get("url")).toBe(
      `${window.location.origin}/?ref=uuid-123`,
    );
  });

  it("is not shown when the program is blocked", async () => {
    mockConfig({ ...CONFIG, available: false });
    renderPaySuccess();
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/me/referrals/config"));
    expect(screen.queryByTestId("pay-success-referral")).toBeNull();
    expect(screen.getByRole("heading", { name: "Оплата прошла успешно" })).toBeInTheDocument();
  });

  it("is not shown to a signed-out visitor", () => {
    session.value = { status: "guest", user: null };
    mockConfig(CONFIG);
    renderPaySuccess();
    expect(screen.queryByTestId("pay-success-referral")).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });
});
