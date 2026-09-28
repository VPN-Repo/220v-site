import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AdminReferrals from "@/pages/AdminReferrals";
import { ADMIN_TOKEN_STORAGE_KEY } from "@/lib/admin";

vi.mock("@/components/AdminPageShell", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const firstUuid = "11111111-1111-1111-8111-111111111111";
const secondUuid = "22222222-2222-2222-8222-222222222222";
const requests = [firstUuid, secondUuid].map((referrerUuid, index) => ({
  id: `request-${index + 1}`,
  referrerUuid,
  email: `user${index + 1}@example.com`,
  type: "prize",
  points: 10,
  status: "pending",
  payload: { prizeTitle: `Приз ${index + 1}` },
}));

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, "admin-test-token");
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("opens paged point history for a request user outside the referrer summary", async () => {
  const pointCalls: string[] = [];
  let profileCalls = 0;
  let paymentCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/summary?")) return jsonResponse(null);
    if (url.includes("/exchange-requests?")) return jsonResponse({ items: requests });
    if (url.endsWith(`/users/${firstUuid}?refresh=1`)) {
      profileCalls += 1;
      return jsonResponse({
        email: "user1@example.com",
        subscription: profileCalls === 1
          ? { plan: "Premium", status: "ACTIVE", expiresAt: "2030-01-01T00:00:00Z" }
          : { plan: "Premium", status: "EXPIRED", expiresAt: "2020-01-01T00:00:00Z" },
      });
    }
    if (url.endsWith(`/users/${firstUuid}/successful-payments`)) {
      paymentCalls += 1;
      return jsonResponse({ count: paymentCalls + 1 });
    }
    if (url.includes(`/users/${firstUuid}/points?`)) {
      pointCalls.push(url);
      const page = Number(new URL(url, "http://localhost").searchParams.get("page"));
      return jsonResponse({
        balance: 12,
        page,
        total: 2,
        total_pages: 2,
        items: [{ id: page, amount: page, reason: "registration", created_at: "2026-01-01T00:00:00Z" }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<AdminReferrals />);
  const historyButtons = await screen.findAllByRole("button", { name: "История" });
  fireEvent.click(historyButtons[0]);
  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByText("Баланс: 12")).toBeInTheDocument();
  expect(within(dialog).getByText("Тариф: Premium")).toBeInTheDocument();
  expect(within(dialog).getByText("Статус тарифа: Активен")).toBeInTheDocument();
  expect(within(dialog).getByText(/Дата окончания:.*2030/)).toBeInTheDocument();
  expect(within(dialog).getByText("Успешных оплат: 2")).toBeInTheDocument();
  expect(within(dialog).getByText("Страница 1 из 2")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Вперёд" }));
  await waitFor(() => expect(within(dialog).getByText("Страница 2 из 2")).toBeInTheDocument());
  expect(pointCalls).toHaveLength(2);
  expect(pointCalls[0]).toContain(`/users/${firstUuid}/points?page=1&limit=20`);
  expect(pointCalls[1]).toContain(`/users/${firstUuid}/points?page=2&limit=20`);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  fireEvent.click(historyButtons[0]);
  expect(await within(screen.getByRole("dialog")).findByText("Статус тарифа: Истёк")).toBeInTheDocument();
  expect(within(screen.getByRole("dialog")).getByText("Успешных оплат: 3")).toBeInTheDocument();
  expect(profileCalls).toBe(2);
});

it("switches history between request users without showing an older response", async () => {
  let resolveFirst: (response: Response) => void = () => {};
  const firstHistory = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  let resolveFirstPayments: (response: Response) => void = () => {};
  const firstPayments = new Promise<Response>((resolve) => { resolveFirstPayments = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/summary?")) return jsonResponse(null);
    if (url.includes("/exchange-requests?")) return jsonResponse({ items: requests });
    if (url.endsWith(`/users/${firstUuid}?refresh=1`)) return jsonResponse({
      email: "user1@example.com",
      subscription: { plan: "Premium", status: "ACTIVE", expiresAt: "2030-01-01T00:00:00Z" },
    });
    if (url.endsWith(`/users/${secondUuid}?refresh=1`)) return jsonResponse({
      email: "user2@example.com",
      subscription: { plan: "Premium", status: "EXPIRED", expiresAt: "2020-01-01T00:00:00Z" },
    });
    if (url.endsWith(`/users/${firstUuid}/successful-payments`)) return firstPayments;
    if (url.endsWith(`/users/${secondUuid}/successful-payments`)) return jsonResponse({ count: 0 });
    if (url.includes(`/users/${firstUuid}/points?`)) return firstHistory;
    if (url.includes(`/users/${secondUuid}/points?`)) return jsonResponse({
      balance: 25, page: 1, total: 1, total_pages: 1,
      items: [{ id: 2, amount: -3, reason: "manual_debit", meta: { comment: "второй пользователь" }, created_at: "2026-01-01T00:00:00Z" }],
    });
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<AdminReferrals />);
  const historyButtons = await screen.findAllByRole("button", { name: "История" });
  fireEvent.click(historyButtons[0]);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
  fireEvent.click(historyButtons[1]);
  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByText("Баланс: 25")).toBeInTheDocument();
  expect(await within(dialog).findByText("Статус тарифа: Истёк")).toBeInTheDocument();
  expect(within(dialog).getByText("Успешных оплат: 0")).toBeInTheDocument();
  expect(within(dialog).getByText(/Дата окончания:.*2020/)).toBeInTheDocument();
  await act(async () => {
    resolveFirst(jsonResponse({ balance: 99, page: 1, total: 0, total_pages: 0, items: [] }));
    resolveFirstPayments(jsonResponse({ count: 9 }));
  });
  expect(within(dialog).getByText("Баланс: 25")).toBeInTheDocument();
  expect(within(dialog).queryByText("Баланс: 99")).not.toBeInTheDocument();
  expect(within(dialog).getByText("Успешных оплат: 0")).toBeInTheDocument();
});

it("debits points from the request row without processing the exchange request", async () => {
  const debitBodies: unknown[] = [];
  const postUrls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes("/summary?")) return jsonResponse(null);
    if (url.includes("/exchange-requests?")) return jsonResponse({ items: requests });
    if (url.endsWith(`/users/${firstUuid}`)) return jsonResponse({ email: "user1@example.com" });
    if (url.endsWith(`/users/${firstUuid}/points/debit`)) {
      postUrls.push(url);
      debitBodies.push(JSON.parse(String(options?.body)));
      return jsonResponse({ balance: 7, status: { penalized: false, pointsBlocked: false } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<AdminReferrals />);
  fireEvent.click((await screen.findAllByRole("button", { name: "Списать" }))[0]);
  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByText("user1@example.com")).toBeInTheDocument();
  fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Количество баллов" }), { target: { value: "3" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Причина списания" }), { target: { value: "корректировка" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Списать" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(postUrls).toHaveLength(1);
  expect(debitBodies).toEqual([{ amount: 3, comment: "корректировка", force: true, pointsBlocked: false, penalized: false }]);
  expect(screen.getAllByRole("button", { name: "Одобрить" })).toHaveLength(2);
});
