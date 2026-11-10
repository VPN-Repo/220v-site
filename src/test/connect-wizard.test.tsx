// The first-device card: one step at a time, phone vs computer, Happ-did-not-open, device check.
// The same file in every brand site: the copy comes from the brand's src/lib/connectBrand.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import ConnectWizard, { detectHereDevice, detectWizardPlatform, isDesktopBrowser } from "@/components/ConnectWizard";
import { apiGet } from "@/lib/api";
import { CONNECT_BRAND } from "@/lib/connectBrand";

const C = CONNECT_BRAND.copy;
const esc = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

vi.mock("@/lib/api", () => ({ apiBase: "/api", apiGet: vi.fn() }));
vi.mock("@/lib/funnel", () => ({ track: vi.fn() }));

const SUB = "https://heltoma.ru/AbCdEfGh123";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8)";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const ua = (value: string) => Object.defineProperty(navigator, "userAgent", { value, configurable: true });

function renderWizard() {
  const onConnected = vi.fn();
  const onOtherDevice = vi.fn();
  const onClose = vi.fn();
  render(<ConnectWizard subscriptionUrl={SUB} onConnected={onConnected} onOtherDevice={onOtherDevice} onClose={onClose} />);
  return { onConnected, onOtherDevice, onClose };
}

describe("ConnectWizard", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockResolvedValue({ data: { devices: [], total: 0 }, error: null, status: 200 } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    ua(WINDOWS);
  });

  it("knows the device and whether it is a computer", () => {
    ua(IPHONE);
    expect([detectWizardPlatform(), isDesktopBrowser()]).toEqual(["ios", false]);
    ua(ANDROID);
    expect([detectWizardPlatform(), isDesktopBrowser()]).toEqual(["android", false]);
    ua(WINDOWS);
    expect([detectWizardPlatform(), isDesktopBrowser()]).toEqual(["windows", true]);
    ua(MAC);
    expect([detectHereDevice(), detectWizardPlatform(), isDesktopBrowser()]).toEqual(["mac", "mac", true]);
  });

  it("iPhone: this device, the real Happ, Happ's region guide, then the one-tap add", () => {
    ua(IPHONE);
    renderWizard();
    expect(screen.getByRole("heading", { name: C.titleThis.iphone })).toBeTruthy();
    expect(screen.getByRole("link", { name: C.installButton.ios }).getAttribute("href")).toBe(
      "https://apps.apple.com/kz/app/happ-proxy-utility/id6504287215",
    );
    // The region note comes before the button.
    expect(screen.getByRole("link", { name: C.appleNoteLink }).getAttribute("href")).toBe("https://happ.info/ru/apple-region/");
    expect(screen.queryByRole("button", { name: C.addButton })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: C.alreadyInstalled }));
    expect(screen.getByText(C.downloaded)).toBeTruthy();
    expect(screen.getByRole("button", { name: C.notInstalledBack })).toBeTruthy();
    expect(screen.getByRole("button", { name: C.addButton })).toBeTruthy();
  });

  it("Android: the APK and the mirror page, never Google Play", () => {
    ua(ANDROID);
    renderWizard();
    expect(screen.getByRole("link", { name: C.installButton.android }).getAttribute("href")).toBe(
      "https://files-hub.com/download/android/latest?arch=universal",
    );
    expect(screen.getByRole("link", { name: C.androidMirror }).getAttribute("href")).toBe("https://files-hub.com/?p=android");
    expect(screen.getByText(C.androidWarning)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("play.google");
  });

  it("after the add: «отправлена»; if nothing happened, a soft hint and the step stays", async () => {
    vi.useFakeTimers();
    ua(IPHONE);
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: C.alreadyInstalled }));
    fireEvent.click(screen.getByRole("button", { name: C.addButton }));
    expect(screen.getByText(C.sent)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    // The page never lost focus or went to the background: probably not installed.
    expect(screen.getByRole("alert").textContent).toContain(C.notOpened);
    expect(screen.getByText(C.sent)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: C.install }));
    expect(screen.getByRole("link", { name: C.installButton.ios })).toBeTruthy();
  });

  it("the browser's «Открыть в Happ?» question (blur) is not taken for a failure", async () => {
    vi.useFakeTimers();
    ua(IPHONE);
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: C.alreadyInstalled }));
    fireEvent.click(screen.getByRole("button", { name: C.addButton }));
    window.dispatchEvent(new Event("blur"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a computer asks: this computer or a phone; a phone gets the QR", async () => {
    ua(WINDOWS);
    renderWizard();
    expect(screen.getByRole("heading", { name: C.titleFirst })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: C.phone }));
    expect(screen.getByRole("heading", { name: C.titlePhone })).toBeTruthy();
    expect(await screen.findByRole("img", { name: C.qrAlt })).toBeTruthy();
    expect(screen.getByText(/files-hub\.com\/\?p=android/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Android/ })).toBeNull();
    expect(screen.queryByRole("button", { name: C.addButton })).toBeNull();
  });

  it("the first device: «Готово! Подписка добавлена в Happ.»", async () => {
    vi.useFakeTimers();
    const { onConnected } = renderWizard();
    vi.mocked(apiGet).mockResolvedValue({ data: { devices: [{}], total: 1 }, error: null, status: 200 } as never);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });
    expect(onConnected).toHaveBeenCalledWith(1);
    expect(screen.getByText(C.done)).toBeTruthy();
  });

  it("coming back to the tab checks at once", async () => {
    const { onConnected } = renderWizard();
    vi.mocked(apiGet).mockResolvedValue({ data: { devices: [{}], total: 1 }, error: null, status: 200 } as never);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(onConnected).toHaveBeenCalledWith(1);
  });

  it("Mac says «этот Mac»; a phone picking a computer is sent to the site on the computer", () => {
    ua(MAC);
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: C.thisComputer }));
    expect(screen.getByRole("heading", { name: C.titleThis.mac })).toBeTruthy();
    cleanup();
    ua(ANDROID);
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: esc(C.otherDevice) }));
    expect(screen.queryByRole("button", { name: "Windows" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: C.computer }));
    expect(screen.getByText(C.computerFromPhone)).toBeTruthy();
  });

  it("«Другое устройство» lists the platforms and the full instructions; closing goes to the page", () => {
    ua(IPHONE);
    const { onOtherDevice, onClose } = renderWizard();
    fireEvent.click(screen.getByRole("button", { name: esc(C.otherDevice) }));
    fireEvent.click(screen.getByRole("button", { name: "Android" }));
    expect(screen.getByRole("heading", { name: C.titlePhone })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: esc(C.otherDevice) }));
    fireEvent.click(screen.getByRole("button", { name: C.tvAndOthers }));
    fireEvent.click(screen.getByRole("button", { name: C.hide }));
    expect(onOtherDevice).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
