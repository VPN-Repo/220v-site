import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AdminReferrals from "@/pages/AdminReferrals";
import { ADMIN_TOKEN_STORAGE_KEY } from "@/lib/admin";

vi.mock("@/components/AdminPageShell", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const uuid = "11111111-1111-1111-8111-111111111111";
const oldPenaltyAt = "2026-01-01T00:00:00.000Z";
const status = { penalized: true, penalizedAt: oldPenaltyAt, pointsBlocked: false };
const counts = { clicks: 0, codes: 0, verifies: 0, checkouts: 0, creditSkipped: 0, selfReferrals: 0 };
const summary = {
  generatedAt: oldPenaltyAt,
  window: { days: 30, since: null, until: oldPenaltyAt },
  totals: { events: 0, referrers: 1, suspiciousReferrers: 0, criticalHighWarnings: 0, selfReferrals: 0, multiAccountDetections: 0 },
  funnel: counts,
  riskSummary: { none: 1, low: 0, medium: 0, high: 0, critical: 0 },
  referrers: [{
    referrerUuid: uuid,
    riskLevel: "none",
    riskScore: 0,
    warnings: [],
    counts,
    unique: { ipHashes: 0, userAgentHashes: 0, fingerprintHashes: 0, referredEmailHashes: 0, referredUuidPrefixes: 0 },
    events: [],
    status,
  }],
  topIps: [], topUserAgents: [], topFingerprints: [], dailyRegistrations: [], events: [],
};

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

it("clears the old penalty badge after an ordinary debit and resets the penalty checkbox", async () => {
  const debitBodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes("/summary?")) return jsonResponse(summary);
    if (url.includes("/exchange-requests?")) return jsonResponse({ items: [] });
    if (url.endsWith(`/users/${uuid}`)) return jsonResponse({ email: "user@example.com", status });
    if (url.includes(`/users/${uuid}/points?`)) return jsonResponse({ balance: 15, items: [] });
    if (url.endsWith(`/users/${uuid}/points/debit`)) {
      debitBodies.push(JSON.parse(String(options?.body)));
      return jsonResponse({ balance: 8, status: { penalized: false, penalizedAt: null, pointsBlocked: false } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));

  const { container } = render(<AdminReferrals />);
  expect((await screen.findAllByText("Оштрафован")).length).toBeGreaterThan(0);
  const details = container.querySelector("details.group") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByRole("button", { name: "Списать" });
  fireEvent.click(screen.getByRole("button", { name: "Списать" }));

  let dialog = screen.getByRole("dialog");
  const penaltyCheckbox = within(dialog).getByRole("checkbox", { name: /Штраф/ });
  expect(penaltyCheckbox).not.toBeChecked();
  fireEvent.click(penaltyCheckbox);
  expect(penaltyCheckbox).toBeChecked();
  fireEvent.click(penaltyCheckbox);
  fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Количество баллов" }), { target: { value: "7" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Причина списания" }), { target: { value: "ручная корректировка" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Списать" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(debitBodies).toEqual([{ amount: 7, comment: "ручная корректировка", force: true, pointsBlocked: false, penalized: false }]);
  expect(screen.queryByText("Оштрафован")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Списать" }));
  dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("checkbox", { name: /Штраф/ })).not.toBeChecked();
});
