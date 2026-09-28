import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AdminReferrals from "@/pages/AdminReferrals";
import { ADMIN_TOKEN_STORAGE_KEY } from "@/lib/admin";

vi.mock("@/components/AdminPageShell", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const exchangeRequest = {
  id: "request-1",
  referrerUuid: "11111111-1111-1111-8111-111111111111",
  email: "user@example.com",
  type: "days",
  points: 20,
  status: "pending",
  payload: { days: 2 },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, "admin-test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("confirms approval, sends the comment and force flag once, then resets the checkbox", async () => {
  let finishApproval: (response: Response) => void = () => {};
  const approvalResponse = new Promise<Response>((resolve) => {
    finishApproval = resolve;
  });
  const approvalBodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes("/summary?")) return jsonResponse(null);
    if (url.includes("/exchange-requests?")) return jsonResponse({ items: [exchangeRequest] });
    if (url.endsWith("/approve")) {
      approvalBodies.push(JSON.parse(String(options?.body)));
      return approvalResponse;
    }
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<AdminReferrals />);
  const approveButton = await screen.findByRole("button", { name: "Одобрить" });
  fireEvent.click(approveButton);

  let dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Комментарий" }), {
    target: { value: "выдано оператором" },
  });
  expect(within(dialog).getByText("user@example.com", { exact: false })).toBeInTheDocument();
  expect(within(dialog).getByText("Дни подписки: 2", { exact: false })).toBeInTheDocument();
  expect(within(dialog).getByText("К списанию:", { exact: false })).toBeInTheDocument();
  expect(approvalBodies).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(approvalBodies).toHaveLength(0);

  fireEvent.click(approveButton);
  dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("textbox", { name: "Комментарий" })).toHaveValue("выдано оператором");
  const checkbox = within(dialog).getByRole("checkbox", { name: /Списать баллы, даже если тариф не активен/ });
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  expect(checkbox).toBeChecked();
  const confirmButton = within(dialog).getByRole("button", { name: "Одобрить и списать баллы" });
  fireEvent.click(confirmButton);
  fireEvent.click(confirmButton);

  expect(approvalBodies).toEqual([{ comment: "выдано оператором", force: true }]);
  expect(within(dialog).getByRole("checkbox")).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Отмена" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  finishApproval(jsonResponse({ request: { ...exchangeRequest, status: "approved" }, exchange: { balance: 80 } }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "Одобрить" }));
  expect(within(screen.getByRole("dialog")).getByRole("checkbox")).not.toBeChecked();
});

it("keeps the approval dialog open and shows an API error", async () => {
  const approvalBodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes("/summary?")) return jsonResponse(null);
    if (url.includes("/exchange-requests?")) return jsonResponse({ items: [exchangeRequest] });
    if (url.endsWith("/approve")) {
      approvalBodies.push(JSON.parse(String(options?.body)));
      return jsonResponse({ error: "Тариф не активен" }, 400);
    }
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<AdminReferrals />);
  fireEvent.click(await screen.findByRole("button", { name: "Одобрить" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Одобрить и списать баллы" }));

  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Тариф не активен");
  expect(approvalBodies).toEqual([{ comment: "Обмен баллов пользователем", force: false }]);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("confirms rejection, keeps the comment draft on cancel, and uses the default for an empty comment", async () => {
  const rejectedBodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes("/summary?")) return jsonResponse(null);
    if (url.includes("/exchange-requests?")) return jsonResponse({ items: [exchangeRequest] });
    if (url.endsWith("/reject")) {
      rejectedBodies.push(JSON.parse(String(options?.body)));
      return jsonResponse({ request: { ...exchangeRequest, status: "rejected" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<AdminReferrals />);
  const rejectButton = await screen.findByRole("button", { name: "Отклонить" });
  fireEvent.click(rejectButton);
  let dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("user@example.com", { exact: false })).toBeInTheDocument();
  expect(within(dialog).getByText("Дни подписки: 2", { exact: false })).toBeInTheDocument();
  expect(within(dialog).getByText("Баллы по заявке:", { exact: false })).toBeInTheDocument();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Комментарий" }), {
    target: { value: "нет приза" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
  expect(rejectedBodies).toHaveLength(0);

  fireEvent.click(rejectButton);
  dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("textbox", { name: "Комментарий" })).toHaveValue("нет приза");
  fireEvent.click(within(dialog).getByRole("button", { name: "Отклонить заявку" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(rejectedBodies).toEqual([{ comment: "нет приза" }]);

  fireEvent.click(rejectButton);
  dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("textbox", { name: "Комментарий" })).toHaveValue("");
  fireEvent.click(within(dialog).getByRole("button", { name: "Отклонить заявку" }));
  await waitFor(() => expect(rejectedBodies).toHaveLength(2));
  expect(rejectedBodies[1]).toEqual({ comment: "Отклонено оператором" });
});

it("shows a rejection error inside the dialog and preserves the comment", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/summary?")) return jsonResponse(null);
    if (url.includes("/exchange-requests?")) return jsonResponse({ items: [exchangeRequest] });
    if (url.endsWith("/reject")) return jsonResponse({ error: "Заявка уже обработана" }, 409);
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<AdminReferrals />);
  fireEvent.click(await screen.findByRole("button", { name: "Отклонить" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Комментарий" }), {
    target: { value: "решение оператора" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Отклонить заявку" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Заявка уже обработана");
  expect(within(dialog).getByRole("textbox", { name: "Комментарий" })).toHaveValue("решение оператора");
});

it("prevents closing or sending rejection twice while the request is pending", async () => {
  let finishRejection: (response: Response) => void = () => {};
  const rejectionResponse = new Promise<Response>((resolve) => { finishRejection = resolve; });
  const rejectedBodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes("/summary?")) return jsonResponse(null);
    if (url.includes("/exchange-requests?")) return jsonResponse({ items: [exchangeRequest] });
    if (url.endsWith("/reject")) {
      rejectedBodies.push(JSON.parse(String(options?.body)));
      return rejectionResponse;
    }
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<AdminReferrals />);
  fireEvent.click(await screen.findByRole("button", { name: "Отклонить" }));
  const dialog = screen.getByRole("dialog");
  const confirmButton = within(dialog).getByRole("button", { name: "Отклонить заявку" });
  fireEvent.click(confirmButton);
  fireEvent.click(confirmButton);
  expect(rejectedBodies).toHaveLength(1);
  expect(within(dialog).getByRole("textbox", { name: "Комментарий" })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Отмена" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  finishRejection(jsonResponse({ request: { ...exchangeRequest, status: "rejected" } }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
