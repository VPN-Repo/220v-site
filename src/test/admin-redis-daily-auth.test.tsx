import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
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

it("shows the preliminary day, breakdown, and earlier days above Redis details", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
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
  }), { status: 200, headers: { "Content-Type": "application/json" } })));

  render(<AdminRedis />);
  const section = await screen.findByRole("heading", { name: "Незавершённая авторизация" });
  const table = section.closest("section")?.querySelector("table");
  expect(table).toBeTruthy();
  const rows = within(table!).getAllByRole("row");
  expect(rows).toHaveLength(3);
  expect(rows[1]).toHaveTextContent("2026-09-28");
  expect(rows[1]).toHaveTextContent("предварительно");
  expect(rows[1]).toHaveTextContent("5");
  expect(rows[1]).toHaveTextContent("3");
  expect(rows[2]).toHaveTextContent("неполный день");
  expect(within(table!).getByRole("columnheader", { name: "Не завершили ввод" })).toBeInTheDocument();
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
