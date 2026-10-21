import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Dashboard from "@/pages/Dashboard";
import Instructions from "@/pages/Instructions";
import RevokeSubscriptionDialog from "@/components/RevokeSubscriptionDialog";
import { apiGet, apiPost } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import SubscriptionQr from "@/components/SubscriptionQr";

vi.mock("@/lib/api", () => ({ apiBase: "/api", apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ status: "authed", email: "user@example.com", user: null, refresh: vi.fn() }),
}));

const SUB = "https://220v.click/AbC123";
const META =
  "https://220v.click/AbC123#220v?fallback-url=https%3A%2F%2F220vsub.online%2FAbC123%23220v";
const DEEP_LINK = `happ://add/${encodeURIComponent(META)}`;

/** Module paths of a locally rendered QR for `value` (error correction M, 4-module quiet zone). */
function expectedQrPaths(value: string): string[] {
  const html = renderToStaticMarkup(<QRCodeSVG value={value} size={220} level="M" marginSize={4} />);
  return [...html.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
}

/** The QR is an inline SVG built in the browser for the meta URL, with no external image. */
function expectLocalQr(qr: HTMLElement) {
  expect(qr.tagName.toLowerCase()).toBe("svg");
  expect(qr).toHaveAttribute("role", "img");
  expect(qr).toHaveAttribute("aria-label", "QR-Code");
  const paths = [...qr.querySelectorAll("path")].map((p) => p.getAttribute("d"));
  expect(paths).toEqual(expectedQrPaths(META));
  expect(paths).not.toEqual(expectedQrPaths(SUB));
  expect(qr.querySelector("path[fill='#FFFFFF']")).not.toBeNull();
  expect(qr.querySelector("path[fill='#000000']")).not.toBeNull();
  expect(document.querySelector("img[src*='qrserver'], img[src^='http']")).toBeNull();
  expect(document.body.innerHTML).not.toContain("qrserver");
}

function mockMe() {
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
              expireAt: new Date(Date.now() + 10 * 86400000).toISOString(),
              daysLeft: 10,
              subscriptionUrl: SUB,
            },
          }
        : {},
    error: null,
    status: 200,
  }));
}

let hrefSetter: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(copyText).mockResolvedValue(true);
  hrefSetter = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...originalLocation,
      get href() {
        return originalLocation.href;
      },
      set href(v: string) {
        hrefSetter(v);
      },
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("Happ fallback link on the dashboard", () => {
  it("Happ button, QR and copy use the meta URL", async () => {
    mockMe();
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
        </Routes>
      </MemoryRouter>,
    );

    const addButton = await screen.findByRole("button", { name: /Добавить в Happ/ });
    await waitFor(() => expect(addButton).not.toBeDisabled());
    fireEvent.click(addButton);
    expect(hrefSetter).toHaveBeenCalledWith(DEEP_LINK);

    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(META, expect.anything()));

    fireEvent.click(screen.getByRole("button", { name: "QR-код" }));
    expectLocalQr(await screen.findByRole("img", { name: "QR-Code" }));
  });
});

function renderInstructions() {
  localStorage.setItem("vpn_subscription_url", SUB);
  mockMe();
  render(
    <MemoryRouter initialEntries={["/instructions?platform=ios"]}>
      <Routes>
        <Route path="/instructions" element={<Instructions />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Happ fallback link in the instructions", () => {
  it("copy and QR use the meta URL (desktop layout)", async () => {
    renderInstructions();

    fireEvent.click(screen.getByRole("button", { name: /Скопировать ссылку подписки/ }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(META, expect.anything()));

    fireEvent.click(screen.getByRole("button", { name: /^QR-Code$/ }));
    expectLocalQr(await screen.findByRole("img", { name: "QR-Code" }));
    expect(document.body.textContent ?? "").not.toContain("fallback-url");
  });

  it("one-click button opens the Happ deep link with the meta URL (phone layout)", async () => {
    const ua = vi
      .spyOn(navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15");
    try {
      renderInstructions();
      fireEvent.click(screen.getByRole("button", { name: "Добавить в один клик" }));
      expect(hrefSetter).toHaveBeenCalledWith(DEEP_LINK);
    } finally {
      ua.mockRestore();
    }
  });
});

describe("Happ fallback link after revoke", () => {
  it("shows the plain URL in the field but copies the meta URL", async () => {
    vi.mocked(apiPost).mockResolvedValue({ data: { ok: true, subscriptionUrl: SUB, user: null }, error: null, status: 200 });
    render(<RevokeSubscriptionDialog open onOpenChange={vi.fn()} onRevoked={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Выпустить новую" }));

    expect(await screen.findByLabelText("Новая ссылка подключения")).toHaveValue(SUB);
    fireEvent.click(screen.getByRole("button", { name: "Скопировать ссылку" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(META, expect.anything()));
  });
});

describe("SubscriptionQr fallback", () => {
  it("shows the copyable link when the code cannot be generated", async () => {
    const tooLong = `${META}${"x".repeat(5000)}`;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<SubscriptionQr value={tooLong} />);
    } finally {
      err.mockRestore();
    }
    expect(screen.queryByRole("img", { name: "QR-Code" })).toBeNull();
    expect(screen.getByLabelText("Ссылка подписки")).toHaveValue(tooLong);
    fireEvent.click(screen.getByRole("button", { name: "Скопировать ссылку" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(tooLong, expect.anything()));
  });
});
