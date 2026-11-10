// The selling landing: offer first screen, live prices, the code screen that survives a reload,
// the cooldown that leads to the code screen, and the test-drive offer in the cabinet.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Index from "@/pages/Index";
import TrialOffer, { trialLeftLabel } from "@/components/TrialOffer";
import { apiGet, apiPost } from "@/lib/api";
import { buildTariffCards, cheapestPerMonth } from "@/lib/tariffPrices";
import { PENDING_LOGIN_TTL_MS, inboxUrlFor, readPendingLogin, savePendingLogin } from "@/lib/pendingLogin";
import { track } from "@/lib/funnel";

vi.mock("@/lib/api", () => ({ apiBase: "/api", apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock("@/lib/funnel", () => ({ track: vi.fn() }));
const refresh = vi.fn(async () => undefined);
vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ refresh }) }));
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => vi.fn() };
});

const META = {
  products: [
    { product_key: "sub_1m", price: 455 },
    { product_key: "sub_6m", price: 2430 },
    { product_key: "sub_12m", price: 4060 },
  ],
};

function renderLanding() {
  render(
    <MemoryRouter>
      <Index />
    </MemoryRouter>,
  );
}

const sendCodeCalls = () => vi.mocked(apiPost).mock.calls.filter(([path]) => path === "/auth/send-code");

describe("selling landing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path === "/me") return { data: null, error: new Error("Требуется авторизация"), status: 401 } as never;
      if (path === "/billing/meta") return { data: META, error: null, status: 200 } as never;
      return { data: null, error: null, status: 200 } as never;
    });
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return { data: { hasPassword: false }, error: null, status: 200 } as never;
      if (path === "/auth/send-code") return { data: { ok: true, retryAfterSec: 30 }, error: null, status: 200 } as never;
      return { data: null, error: null, status: 200 } as never;
    });
  });

  it("prices: live from RMW, discount and per-month from the month price", () => {
    const cards = buildTariffCards({ sub_1m: 455, sub_6m: 2430, sub_12m: 4060 });
    expect(cards.map((c) => [c.months, c.price, c.perMonth, c.discountPercent])).toEqual([
      [1, 455, 455, 0],
      [6, 2430, 405, 11],
      [12, 4060, 338, 26],
    ]);
    expect(cheapestPerMonth(cards)).toBe(338);
  });

  it("first screen sells: the offer, the free test-drive button and the price from the API", async () => {
    renderLanding();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Включитесь на все 220");
    expect(screen.getAllByRole("button", { name: /Попробовать бесплатно/ }).length).toBeGreaterThan(0);
    expect(await screen.findByText("Тарифы — от 338 ₽ в месяц ↓")).toBeInTheDocument();
    expect(within(screen.getByTestId("plan-12")).getByText("4 060")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Войти в аккаунт" })).toBeInTheDocument();
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/vpn|впн/);
    expect(track).toHaveBeenCalledWith("landing_view_new", { once: true });
  });

  it("choosing a plan on the page opens the login and remembers the payment", async () => {
    renderLanding();
    fireEvent.click(await within(await screen.findByTestId("plan-6")).findByRole("button", { name: "Выбрать 6 месяцев" }));
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith("plan_select");
  });

  it("the code screen comes back after a reload within 10 minutes", async () => {
    savePendingLogin("ivan@mail.ru", Date.now() - 60_000);
    renderLanding();
    expect(await screen.findByRole("heading", { name: "Введите код" })).toBeInTheDocument();
    expect(screen.getByText("ivan", { exact: false, selector: "b" })).toBeInTheDocument();
    expect(screen.getByTestId("login-mail-hint")).toHaveTextContent("Загляните в «Спам»");
    expect(screen.getByRole("link", { name: "Открыть Почту Mail.ru" })).toHaveAttribute("href", "https://e.mail.ru/inbox/");
    expect(track).toHaveBeenCalledWith("code_screen_restored");
    expect(sendCodeCalls()).toHaveLength(0);
  });

  it("an old pending login is forgotten", () => {
    savePendingLogin("ivan@mail.ru", Date.now() - PENDING_LOGIN_TTL_MS - 1000);
    expect(readPendingLogin()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("a fresh code already on its way leads to the code screen, not an error", async () => {
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === "/auth/method") return { data: { hasPassword: false }, error: null, status: 200 } as never;
      if (path === "/auth/send-code")
        return {
          data: { error: "Повторный код — через 20 сек.", code: "otp_cooldown" },
          error: new Error("cooldown"),
          status: 429,
          retryAfterSec: 20,
        } as never;
      return { data: null, error: null, status: 200 } as never;
    });
    renderLanding();
    fireEvent.click(await screen.findByRole("button", { name: "Войти" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ivan@gmail.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(await screen.findByRole("heading", { name: "Введите код" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Повторная отправка через 20 сек/ })).toBeDisabled();
    expect(readPendingLogin()?.email).toBe("ivan@gmail.com");
  });

  it("knows the web inbox of the common mail services", () => {
    expect(inboxUrlFor("a@gmail.com")?.url).toContain("mail.google.com");
    expect(inboxUrlFor("a@ya.ru")?.url).toBe("https://mail.yandex.ru/");
    expect(inboxUrlFor("a@company.org")).toBeNull();
  });
});

describe("test-drive offer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiGet).mockResolvedValue({ data: META, error: null, status: 200 } as never);
  });

  it("says how much of the test is left and offers the plan most people take", async () => {
    const onChoose = vi.fn();
    render(<TrialOffer msLeft={4 * 3_600_000 + 25 * 60_000} expired={false} onChoose={onChoose} onAllPlans={vi.fn()} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Тест-драйв: осталось 4 ч 25 мин");
    expect(await screen.findByText("6 месяцев — 2 430 ₽, это ≈ 405 ₽ в месяц")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Оформить на 6 месяцев" }));
    expect(onChoose).toHaveBeenCalledWith(6);
    expect(track).toHaveBeenCalledWith("trial_offer_click");
  });

  it("after the test: «Вернуть доступ»", () => {
    render(<TrialOffer msLeft={0} expired onChoose={vi.fn()} onAllPlans={vi.fn()} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Тест-драйв закончился");
    expect(screen.getByRole("button", { name: "Вернуть доступ" })).toBeInTheDocument();
    expect(trialLeftLabel(30 * 60_000)).toBe("30 мин");
  });
});
