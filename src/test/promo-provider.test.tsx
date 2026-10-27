import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { PromoProvider } from "@/components/PromoProvider";
import { usePromo } from "@/hooks/usePromo";
import TariffPay from "@/pages/TariffPay";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  refresh: vi.fn(),
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
  session: { status: "authed", email: "user@example.com", user: { userUuid: "00000000-0000-4000-8000-000000000000" } },
}));
vi.mock("@/lib/api", () => ({ apiBase: "/api", apiGet: mocks.apiGet, apiPost: mocks.apiPost, apiDelete: vi.fn() }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ ...mocks.session, refresh: mocks.refresh }) }));

const ok = (data: unknown) => ({ status: 200, data, error: null });
const unauthorized = { status: 401, error: new Error("Требуется авторизация"), data: null };
const saved = { kind: "sale" as const, code: "SAVED", activated_at: "2026-10-01T00:00:00Z" };
const posts = (path: string) => mocks.apiPost.mock.calls.filter(([p]) => p === path);

function Probe() {
  const promo = usePromo();
  const location = useLocation();
  const action = useNavigationType();
  const [code, setCode] = useState("");
  return (
    <>
      <output data-testid="location">{location.pathname + location.search + location.hash}</output>
      <output data-testid="action">{action}</output>
      <output data-testid="active">{promo.activePromo?.code ?? "none"}</output>
      <button type="button" onClick={() => void promo.refreshActivePromo()}>Обновить</button>
      <input aria-label="Код скидки" value={code} onChange={(e) => setCode(e.target.value)} />
      <button
        type="button"
        disabled={promo.resolving}
        onClick={async () => {
          if (await promo.resolveManualPromo(code)) setCode("");
        }}
      >
        {promo.resolving ? "Сохраняем..." : "Сохранить скидку"}
      </button>
    </>
  );
}

function tree(url: string) {
  return (
    <StrictMode>
      <MemoryRouter initialEntries={[url]}>
        <PromoProvider>
          <Routes>
            <Route path="*" element={<Probe />} />
          </Routes>
        </PromoProvider>
      </MemoryRouter>
    </StrictMode>
  );
}

async function ready() {
  await screen.findByRole("button", { name: /Сохранить скидку|Сохраняем/ });
}

describe("PromoProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.session.status = "authed";
    mocks.apiGet.mockResolvedValue(ok({ active: false, promo: null }));
    mocks.apiPost.mockImplementation(async (path: string) => ok(path === "/promo/resolve" ? { status: "none" } : { ok: true }));
  });
  afterEach(cleanup);

  it("captures a link on any route, cleans the address and resolves once under StrictMode", async () => {
    render(tree("/chat?from=mail&psale=%20code%20#top"));
    await ready();
    await waitFor(() => expect(posts("/promo/resolve")).toHaveLength(1));
    expect(posts("/promo/capture")).toEqual([["/promo/capture", { kind: "sale", promo_code: "CODE" }]]);
    expect(posts("/promo/resolve")[0][1]).toBeUndefined();
    expect(screen.getByTestId("location")).toHaveTextContent("/chat?from=mail#top");
    expect(screen.getByTestId("action")).toHaveTextContent("REPLACE");
  });

  it("holds the pages until the link is processed", async () => {
    let finishCapture!: (value: unknown) => void;
    mocks.apiPost.mockImplementation((path: string) =>
      path === "/promo/capture" ? new Promise((r) => { finishCapture = r; }) : Promise.resolve(ok({ status: "none" })),
    );
    render(tree("/?pdays=A"));
    expect(await screen.findByLabelText("Обработка промокода")).toBeInTheDocument();
    expect(screen.queryByTestId("location")).toBeNull();
    await act(async () => finishCapture(ok({ ok: true })));
    await ready();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
  });

  it("cleans an invalid link without touching an older pending code", async () => {
    render(tree("/?pdays=A&psale=B&from=mail#anchor"));
    await ready();
    expect(mocks.toast.error).toHaveBeenCalledWith("В ссылке больше одного промокода");
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(mocks.apiGet).toHaveBeenCalledWith("/promo/active");
    expect(screen.getByTestId("location")).toHaveTextContent("/?from=mail#anchor");
  });

  it.each([false, true])("keeps a valid link in the address when capture fails (network=%s)", async (network) => {
    mocks.apiPost.mockResolvedValue(
      network ? { status: 0, error: new Error("offline"), data: null } : { status: 503, error: new Error("Unavailable"), data: null },
    );
    render(tree("/?psale=A#hash"));
    await ready();
    expect(screen.getByTestId("location")).toHaveTextContent("/?psale=A#hash");
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).toHaveBeenCalled();
  });

  it("tells a guest the code waits for login and queues the login form, but only for a link", async () => {
    mocks.session.status = "guest";
    mocks.apiPost.mockImplementation(async (path: string) => (path === "/promo/capture" ? ok({ ok: true }) : unauthorized));
    mocks.apiGet.mockResolvedValue(unauthorized);
    render(tree("/?psale=A"));
    await ready();
    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledWith("Промокод сохранён и применится после входа"));
    expect(sessionStorage.getItem("vpn_pending_redirect")).toBe("/tariff");
    cleanup();
    vi.clearAllMocks();
    render(tree("/"));
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith("/promo/active"));
    expect(posts("/promo/resolve")).toHaveLength(0);
    expect(mocks.toast.info).not.toHaveBeenCalled();
  });

  it("resolves the pending code after login without a route change and opens the tariffs", async () => {
    mocks.session.status = "guest";
    const view = render(tree("/"));
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalled());
    mocks.session.status = "authed";
    mocks.apiPost.mockResolvedValue(ok({ status: "pending_checkout_validation", promo: saved }));
    mocks.apiGet.mockResolvedValue(ok({ active: true, promo: saved }));
    view.rerender(tree("/"));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/tariff"));
    expect(screen.getByTestId("active")).toHaveTextContent("SAVED");
    expect(mocks.toast.success).toHaveBeenCalledWith("Скидка по промокоду SAVED будет учтена при оплате");
  });

  it("stays on a purchase screen when a discount link is opened there", async () => {
    mocks.apiPost.mockImplementation(async (path: string) =>
      ok(path === "/promo/resolve" ? { status: "pending_checkout_validation", promo: saved } : { ok: true }),
    );
    render(tree("/traffic/pay?gb=20&psale=SAVED"));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled());
    expect(screen.getByTestId("location")).toHaveTextContent("/traffic/pay?gb=20");
  });

  it("refreshes the profile and announces granted days", async () => {
    const onDays = vi.fn();
    window.addEventListener("v220:promo-days-applied", onDays);
    mocks.apiPost.mockImplementation(async (path: string) =>
      ok(path === "/promo/resolve" ? { status: "days_applied", days_added: 1 } : { ok: true }),
    );
    render(tree("/chat?pdays=GIFT"));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.toast.success).toHaveBeenCalledWith("Промокод применён: добавлено 1 день");
    expect(onDays).toHaveBeenCalledTimes(1);
    window.removeEventListener("v220:promo-days-applied", onDays);
  });

  it("validates manual input, sends a single sale and shows progress", async () => {
    render(tree("/dashboard"));
    await ready();
    await waitFor(() => expect(posts("/promo/resolve")).toHaveLength(1));
    mocks.apiPost.mockClear();
    fireEvent.change(screen.getByLabelText("Код скидки"), { target: { value: "https://220v.shop/?psale=A" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить скидку" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Нужен только код, без ссылки и параметров"));
    expect(mocks.apiPost).not.toHaveBeenCalled();
    let complete!: (value: unknown) => void;
    mocks.apiPost.mockImplementation(() => new Promise((r) => { complete = r; }));
    fireEvent.change(screen.getByLabelText("Код скидки"), { target: { value: " spring20 " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить скидку" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Сохраняем..." })).toBeDisabled());
    expect(mocks.apiPost.mock.calls).toEqual([["/promo/resolve", { kind: "sale", promo_code: "SPRING20" }]]);
    await act(async () => complete(ok({ status: "pending_checkout_validation", promo: saved })));
    await waitFor(() => expect(screen.getByLabelText("Код скидки")).toHaveValue(""));
  });

  it("keeps the known discount on a transient error and drops it once the session is gone", async () => {
    mocks.apiGet.mockResolvedValue(ok({ active: true, promo: saved }));
    render(tree("/dashboard"));
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("SAVED"));
    mocks.apiGet.mockResolvedValue({ status: 0, error: new Error("offline"), data: null });
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await act(async () => {});
    expect(screen.getByTestId("active")).toHaveTextContent("SAVED");
    mocks.apiGet.mockResolvedValue(unauthorized);
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("none"));
  });
});

describe("tariff payment with a saved discount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.status = "authed";
    mocks.apiGet.mockImplementation(async (path: string) => {
      if (path === "/promo/active") return ok({ active: true, promo: saved });
      if (path === "/billing/meta") {
        return ok({
          payments: [
            { id: 2, type: "sbp", label: "СБП (QR-код)", provider: "yookassa" },
            { id: 11, type: "card", label: "Оплата картой", provider: "tribute" },
          ],
          products: [{ product_key: "sub_1m", price: 450 }],
        });
      }
      if (path === "/me") return ok({ user: { userUuid: "00000000-0000-4000-8000-000000000000", tariff: "trial" } });
      return ok({});
    });
    mocks.apiPost.mockImplementation(async (path: string) =>
      ok(path === "/promo/resolve" ? { status: "none" } : path === "/checkout" ? {} : { ok: true }),
    );
  });
  afterEach(cleanup);

  it("shows the base price with a notice, disables Tribute and asserts the code at checkout", async () => {
    render(
      <MemoryRouter initialEntries={["/tariff/pay?months=1"]}>
        <PromoProvider>
          <Routes>
            <Route path="/tariff/pay" element={<TariffPay />} />
          </Routes>
        </PromoProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("promo-checkout-notice")).toHaveTextContent("SAVED");
    expect(screen.getByText(/1 месяц — 450/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Оплата картой/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "СБП (QR-код)" }));
    await waitFor(() =>
      expect(mocks.apiPost).toHaveBeenCalledWith("/checkout", {
        product_key: "sub_1m",
        payment_method: 2,
        expected_promo_code: "SAVED",
      }),
    );
  });
});
