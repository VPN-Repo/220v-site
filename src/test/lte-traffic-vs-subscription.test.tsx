import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Dashboard from "@/pages/Dashboard";
import Tariff from "@/pages/Tariff";
import TariffPay from "@/pages/TariffPay";
import Traffic from "@/pages/Traffic";
import TrafficPay from "@/pages/TrafficPay";
import { apiGet } from "@/lib/api";
import { formatDaysRu } from "@/lib/lteTraffic";

vi.mock("@/lib/api", () => ({ apiBase: "/api", apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn() }));
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ status: "authed", email: "user@example.com", user: null, refresh: vi.fn() }),
}));

const now = new Date("2026-09-14T12:00:00Z");
const hour = 60 * 60 * 1000;
const day = 24 * hour;
const GB = 1024 * 1024 * 1024;

function expectedDate(remainingMs: number) {
  return new Date(now.getTime() + remainingMs).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function mockApi(remainingMs: number, traffic: { used?: number; limit?: number } = {}) {
  vi.mocked(apiGet).mockImplementation(async (path: string) => ({
    data:
      path === "/me"
        ? {
            user: {
              tariff: "1month",
              plan: "1 Месяц",
              status: "ACTIVE",
              username: "test",
              userUuid: "00000000-0000-4000-8000-000000000000",
              email: "user@example.com",
              expireAt: new Date(now.getTime() + remainingMs).toISOString(),
              daysLeft: Math.floor(remainingMs / day),
              usedTrafficBytes: traffic.used ?? 0,
              trafficLimitBytes: traffic.limit ?? 10 * GB,
            },
          }
        : path === "/billing/meta"
          ? {
              payments: [{ id: 2, type: "sbp", label: "СБП" }],
              products: [
                { product_key: "sub_1m", price: 199 },
                { product_key: "sub_6m", price: 999 },
                { product_key: "sub_12m", price: 1799 },
                { product_key: "traffic_20gb", price: 150 },
                { product_key: "traffic_50gb", price: 300 },
              ],
            }
          : {},
    error: null,
    status: 200,
  }));
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/tariff" element={<Tariff />} />
        <Route path="/tariff/pay" element={<TariffPay />} />
        <Route path="/traffic" element={<Traffic />} />
        <Route path="/traffic/pay" element={<TrafficPay />} />
      </Routes>
    </MemoryRouter>,
  );
}

const warningText = /купленный LTE-трафик сгорит вместе с ней/;

describe("LTE traffic vs subscription renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("pluralises days", () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111].map(formatDaysRu)).toEqual([
      "1 день",
      "2 дня",
      "5 дней",
      "11 дней",
      "12 дней",
      "21 день",
      "22 дня",
      "25 дней",
      "111 дней",
    ]);
  });

  describe("/traffic", () => {
    it("uses the LTE wording for the title, explainer, packages and sidebar", async () => {
      mockApi(10 * day);
      renderAt("/traffic");
      expect(screen.getByRole("heading", { level: 1, name: "Докупка LTE-трафика" })).toBeInTheDocument();
      expect(
        await screen.findByText(
          `Трафик считается только на LTE-серверах — на остальных безлимит. Купленные ГБ действуют до конца подписки (${expectedDate(10 * day)}). Срок подписки не продлевается.`,
        ),
      ).toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: "+20 ГБ LTE" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "+50 ГБ LTE" })).toBeInTheDocument();
      expect(screen.queryByText(warningText)).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /Докупить LTE-трафик/ }).length).toBeGreaterThan(0);
      expect(screen.queryByText("Купить трафик")).not.toBeInTheDocument();
    });

    it("warns at three days or less and hides the packages", async () => {
      mockApi(3 * day);
      renderAt("/traffic");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `Подписка заканчивается через 3 дня (${expectedDate(3 * day)}) — купленный LTE-трафик сгорит вместе с ней. Возможно, вы хотели продлить подписку?`,
      );
      expect(screen.queryByRole("heading", { name: "+20 ГБ LTE" })).not.toBeInTheDocument();
      cleanup();

      mockApi(day + hour);
      renderAt("/traffic");
      expect(await screen.findByRole("alert")).toHaveTextContent("Подписка заканчивается через 1 день");
      cleanup();

      mockApi(12 * hour);
      renderAt("/traffic");
      expect(await screen.findByRole("alert")).toHaveTextContent("Подписка заканчивается менее чем через сутки");
    });

    it("sends «Продлить подписку» to the tariff flow", async () => {
      mockApi(2 * day);
      renderAt("/traffic");
      fireEvent.click(await screen.findByRole("button", { name: "Продлить подписку" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Продление подписки" })).toBeInTheDocument();
      expect(screen.getByText("Что вы получите: +1/6/12 мес. доступа")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "6 месяцев" })).toBeInTheDocument();
    });

    it("shows the packages after «Всё равно докупить трафик»", async () => {
      mockApi(2 * day);
      renderAt("/traffic");
      fireEvent.click(await screen.findByRole("button", { name: "Всё равно докупить трафик" }));
      expect(screen.queryByText(warningText)).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "+20 ГБ LTE" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "+50 ГБ LTE" })).toBeInTheDocument();
    });
  });

  describe("/traffic/pay", () => {
    it("summarises the purchase and links to renewal", async () => {
      mockApi(10 * day);
      renderAt("/traffic/pay?gb=50");
      expect(screen.getByRole("heading", { level: 1, name: "Оплата LTE-трафика" })).toBeInTheDocument();
      expect(await screen.findByTestId("traffic-purchase-summary")).toHaveTextContent(
        `Вы покупаете: +50 ГБ LTE-трафика · 300 ₽. Действует до ${expectedDate(10 * day)}. Срок подписки не продлевается.`,
      );
      fireEvent.click(screen.getByRole("button", { name: "Мне нужно продлить подписку →" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Продление подписки" })).toBeInTheDocument();
    });
  });

  describe("/tariff", () => {
    it("suggests buying traffic when only LTE traffic is exhausted", async () => {
      mockApi(10 * day, { used: 10 * GB, limit: 10 * GB });
      renderAt("/tariff");
      const hint = await screen.findByTestId("traffic-instead-hint");
      expect(hint).toHaveTextContent(
        "У вас ещё 10 дней подписки — закончился только LTE-трафик. Его можно докупить отдельно, это дешевле.",
      );
      expect(screen.getByRole("heading", { name: "1 месяц" })).toBeInTheDocument();
      fireEvent.click(within(hint).getByRole("button", { name: "Докупить LTE-трафик" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Докупка LTE-трафика" })).toBeInTheDocument();
    });

    it("does not suggest traffic when traffic remains or the subscription is ending", async () => {
      mockApi(10 * day, { used: 2 * GB, limit: 10 * GB });
      renderAt("/tariff");
      expect(await screen.findByRole("heading", { level: 1, name: "Продление подписки" })).toBeInTheDocument();
      expect(screen.queryByTestId("traffic-instead-hint")).not.toBeInTheDocument();
      cleanup();

      mockApi(2 * day, { used: 10 * GB, limit: 10 * GB });
      renderAt("/tariff");
      expect(await screen.findByRole("heading", { level: 1, name: "Продление подписки" })).toBeInTheDocument();
      expect(screen.queryByTestId("traffic-instead-hint")).not.toBeInTheDocument();
    });

    it("titles the payment page as a renewal with the months gained", async () => {
      mockApi(10 * day);
      renderAt("/tariff/pay?months=6");
      expect(await screen.findByRole("heading", { level: 1, name: "Продление подписки" })).toBeInTheDocument();
      expect(await screen.findByText("Подписка на 6 месяцев — 999 ₽. Что вы получите: +6 мес. доступа")).toBeInTheDocument();
    });
  });

  describe("dashboard", () => {
    it("labels the traffic card and opens /traffic", async () => {
      mockApi(10 * day);
      renderAt("/dashboard");
      expect(await screen.findByText("LTE-трафик")).toBeInTheDocument();
      const buttons = screen.getAllByRole("button", { name: "Докупить LTE-трафик" });
      fireEvent.click(buttons[buttons.length - 1]);
      expect(await screen.findByRole("heading", { level: 1, name: "Докупка LTE-трафика" })).toBeInTheDocument();
    });

    it("warns in the ?buy=traffic dialog, then shows packages and the summary", async () => {
      mockApi(2 * day);
      renderAt("/dashboard?buy=traffic");
      expect(await screen.findByRole("heading", { name: "Докупка LTE-трафика" })).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(
        `Подписка заканчивается через 2 дня (${expectedDate(2 * day)}) — купленный LTE-трафик сгорит вместе с ней.`,
      );
      expect(screen.queryByRole("button", { name: /\+20 ГБ LTE/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Всё равно докупить трафик" }));
      fireEvent.click(await screen.findByRole("button", { name: /\+50 ГБ LTE/ }));
      expect(screen.getByTestId("traffic-purchase-summary")).toHaveTextContent(
        `Вы покупаете: +50 ГБ LTE-трафика · 300 ₽. Действует до ${expectedDate(2 * day)}. Срок подписки не продлевается.`,
      );
      expect(screen.getByRole("button", { name: "СБП" })).toBeEnabled();
    });

    it("does not warn in the dialog at ten days and renews from the warning", async () => {
      mockApi(10 * day);
      renderAt("/dashboard?buy=traffic");
      expect(await screen.findByRole("button", { name: /\+20 ГБ LTE/ })).toBeInTheDocument();
      expect(screen.queryByText(warningText)).not.toBeInTheDocument();
      cleanup();

      mockApi(day);
      renderAt("/dashboard?buy=traffic");
      fireEvent.click(await screen.findByRole("button", { name: "Продлить подписку" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Продление подписки" })).toBeInTheDocument();
    });
  });
});
