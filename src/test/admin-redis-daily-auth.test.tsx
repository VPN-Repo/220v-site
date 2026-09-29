import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AdminRedis from "@/pages/AdminRedis";
import { ADMIN_TOKEN_STORAGE_KEY } from "@/lib/admin";

vi.mock("@/components/AdminPageShell", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

beforeEach(() => localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, "admin-test-token"));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("sums the displayed days and shows the unfinished share above Redis details", async () => {
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes("/redis-auth/unfinished?")) {
      expect(options?.headers).toEqual({ "X-Admin-Token": "admin-test-token" });
      return new Response(JSON.stringify({
        total: 5, available: 2, unavailable: 3, offset: 0, limit: 50,
        items: [
          { date: "2026-09-28", email: "first@gmail.com", reason: "no_code_submitted" },
          { date: "2026-09-27", email: "second@gmail.com", reason: "code_not_accepted" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
    generatedAt: "2026-09-28T12:00:00Z",
    dailyAuth: {
      timeZone: "Europe/Moscow",
      startedAt: "2026-09-27T10:00:00Z",
      today: "2026-09-28",
      days: [
        { date: "2026-09-28", sent: 5, unfinished: 3, noCodeSubmitted: 2, codeNotAccepted: 1, preliminary: true, partial: false },
        { date: "2026-09-27", sent: 4, unfinished: 2, noCodeSubmitted: 1, codeNotAccepted: 1, preliminary: false, partial: true },
      ],
    },
    totals: { otp: 0, cooldowns: 0, sessions: 0, rateLimits: 0, events: 0 },
    otp: [], cooldowns: [], sessions: [],
    rateLimits: { sendCodeIp: [], sendCodeEmail: [], verifyIp: [], checkoutSession: [] },
    stats: { byType: [], byIp: [], byEmailHash: [] },
    events: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<AdminRedis />);
  const section = await screen.findByRole("heading", { name: "Незавершённая авторизация" });
  const summary = section.closest("section");
  expect(summary).toHaveTextContent("Сумма по показанным календарным дням Москвы");
  const statCard = (label: string) => within(summary!).getByText(label, { selector: "p" }).closest(".rounded-xl")!;
  expect(statCard("Запросили код")).toHaveTextContent("9");
  expect(statCard("Не завершили ввод")).toHaveTextContent("5 (56%)");
  expect(statCard("Не отправили код на проверку")).toHaveTextContent("3");
  expect(statCard("Отправили, но код не принят")).toHaveTextContent("2");
  expect(statCard("Не завершили ввод").querySelector("p.mt-2")).toHaveTextContent("5 (56%)");
  const table = summary?.querySelector("table");
  expect(table).toBeTruthy();
  const rows = within(table!).getAllByRole("row");
  expect(rows).toHaveLength(3);
  expect(rows[1]).toHaveTextContent("2026-09-28");
  expect(rows[1]).toHaveTextContent("предварительно");
  expect(rows[1]).toHaveTextContent("5");
  expect(rows[1]).toHaveTextContent("3");
  expect(rows[2]).toHaveTextContent("неполный день");
  expect(within(table!).getByRole("columnheader", { name: "Не завершили ввод" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Показать email с незавершённым входом" }));
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("first@gmail.com")).toBeInTheDocument();
  expect(within(dialog).getByText("second@gmail.com")).toBeInTheDocument();
  expect(within(dialog).getByText("Код не отправлен на проверку")).toBeInTheDocument();
  expect(within(dialog).getByText("Код не принят")).toBeInTheDocument();
  expect(within(dialog).getByText(/Для 3 более ранних записей/)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/redis-auth/unfinished?offset=0&limit=50"), expect.anything());
});

it("explains why the history is empty before collection starts", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    generatedAt: "2026-09-28T12:00:00Z",
    dailyAuth: { timeZone: "Europe/Moscow", startedAt: null, today: "2026-09-28", days: [] },
    totals: { otp: 0, cooldowns: 0, sessions: 0, rateLimits: 0, events: 0 },
    otp: [], cooldowns: [], sessions: [],
    rateLimits: { sendCodeIp: [], sendCodeEmail: [], verifyIp: [], checkoutSession: [] },
    stats: { byType: [], byIp: [], byEmailHash: [] }, events: [],
  }), { status: 200, headers: { "Content-Type": "application/json" } })));
  render(<AdminRedis />);
  expect(await screen.findByText(/Нет данных. Сбор начнётся/)).toBeInTheDocument();
});
