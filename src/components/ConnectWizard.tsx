// «Подключите …»: shown at the top of the cabinet while the account has no device.
//
// One step at a time. By default it connects the device the page is open on: install Happ, add the
// subscription in one tap. On a computer it first asks whether to connect this computer or a phone
// (a phone gets a QR code). A quiet check of /me/devices notices the first device (Happ fetched the
// subscription) and switches the card to «Готово».
//
// The same file in every brand site. Copy, colours and the Happ links are the brand's own, in
// src/lib/connectBrand.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Apple, Check, ChevronDown, Laptop, Loader2, Monitor, Smartphone, Terminal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api";
import { track } from "@/lib/funnel";
import { CONNECT_BRAND as BRAND } from "@/lib/connectBrand";

/** Install targets. Mac uses the same App Store app as iPhone and iPad. */
export type WizardPlatform = "ios" | "mac" | "android" | "windows" | "linux";
/** What the page is open on, for the copy («этот iPhone», «этот Mac»). */
export type HereDevice = "iphone" | "ipad" | "mac" | "android" | "windows" | "linux";

type PlatformInfo = { id: WizardPlatform; label: string; install: string; computer: boolean };

/** Happ downloads. Happ left Google Play (APK from the mirror) and the Russian App Store (Kazakhstan). */
const APP_STORE_KZ = "https://apps.apple.com/kz/app/happ-proxy-utility/id6504287215";
const PLATFORMS: PlatformInfo[] = [
  { id: "ios", label: "iPhone, iPad", install: APP_STORE_KZ, computer: false },
  {
    id: "android",
    label: "Android",
    install: "https://files-hub.com/download/android/latest?arch=universal",
    computer: false,
  },
  { id: "mac", label: "Mac", install: APP_STORE_KZ, computer: true },
  {
    id: "windows",
    label: "Windows",
    install: "https://files-hub.com/download/windows/latest?arch=x64",
    computer: true,
  },
  {
    id: "linux",
    label: "Linux",
    install: "https://files-hub.com/download/linux/latest?arch=x64&package=deb",
    computer: true,
  },
];

const ICONS: Record<WizardPlatform, typeof Smartphone> = { ios: Apple, mac: Laptop, android: Smartphone, windows: Monitor, linux: Terminal };
const ANDROID_MIRROR_URL = "https://files-hub.com/?p=android";
const APPLE_REGION_GUIDE_URL = "https://happ.info/ru/apple-region/";
const C = BRAND.copy;

/** The device the page is open on. */
export function detectHereDevice(): HereDevice {
  if (typeof navigator === "undefined") return "windows";
  const ua = navigator.userAgent;
  const maxTouch = navigator.maxTouchPoints ?? 0;
  if (/iPhone|iPod/.test(ua)) return "iphone";
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && maxTouch > 1)) return "ipad";
  if (/Android/i.test(ua)) return "android";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Linux/i.test(ua)) return "linux";
  return "windows";
}

export function platformOf(device: HereDevice): WizardPlatform {
  return device === "iphone" || device === "ipad" ? "ios" : device;
}

/** Kept for callers that only need the install target. */
export function detectWizardPlatform(): WizardPlatform {
  return platformOf(detectHereDevice());
}

/** A computer (no touch phone/tablet): it may want to connect a phone instead. */
export function isDesktopBrowser(): boolean {
  const device = detectHereDevice();
  return device === "mac" || device === "windows" || device === "linux";
}

const POLL_MS = 8_000;
/** The check runs this long after the last sign of life on the page (back from Happ, a click). */
const POLL_FOR_MS = 15 * 60_000;
/** After the one-tap add: no sign of leaving the page this long means Happ probably did not open. */
const APP_OPEN_WAIT_MS = 3_000;

/** What a brand site provides: its copy, colours, QR and Happ link builders (src/lib/connectBrand.tsx). */
export type ConnectBrand = {
  /** happ://add/… deep link for a subscription link. */
  addLink: (subscriptionUrl: string) => string;
  /** What the QR code encodes for Happ to scan. */
  qrValue: (subscriptionUrl: string) => string;
  /** The site's own QR component (drawn in the browser, the link never leaves it). */
  Qr: (props: { value: string; alt: string }) => JSX.Element;
  /** Tailwind classes: the «add» button, the done box (background + ring colour) and the done icon. */
  actionClass: string;
  doneBoxClass: string;
  doneIconClass: string;
  copy: {
    titleFirst: string;
    titlePhone: string;
    titleComputer: string;
    titleThis: Record<HereDevice, string>;
    subtitle: string;
    thisComputer: string;
    phone: string;
    computer: string;
    stepInstall: string;
    appleNote: string;
    appleNoteLink: string;
    installButton: Record<WizardPlatform, string>;
    androidWarning: string;
    androidMirror: string;
    alreadyInstalled: string;
    downloaded: string;
    back: string;
    stepAdd: string;
    addButton: string;
    notInstalledBack: string;
    sent: string;
    notOpened: string;
    retry: string;
    install: string;
    phoneStepInstall: string;
    phoneIphone: string;
    phoneIphoneLink: string;
    phoneAndroid: string;
    phoneStepScan: string;
    qrAlt: string;
    computerFromPhone: string;
    waiting: string;
    otherDevice: string;
    tvAndOthers: string;
    done: string;
    close: string;
    hide: string;
  };
};

type Target = "here" | "phone" | "computer";
type Step = "install" | "add" | "sent";

type ConnectWizardProps = {
  subscriptionUrl: string;
  /** The first device appeared: the new device count. */
  onConnected: (total: number) => void;
  /** «Телевизор и остальное»: the full instructions. */
  onOtherDevice: () => void;
  onClose: () => void;
};

const StepDone = ({ children, onChange }: { children: React.ReactNode; onChange: () => void }) => (
  <div className="flex items-center gap-2 rounded-xl bg-card px-3 py-1 text-sm ring-1 ring-border">
    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${BRAND.doneIconClass}`}>
      <Check className="h-3 w-3" />
    </span>
    <span className="min-w-0 flex-1 text-foreground">{children}</span>
    <button type="button" onClick={onChange} className="min-h-11 shrink-0 text-xs font-semibold text-primary hover:underline">
      {C.back}
    </button>
  </div>
);

const SecondaryLink = ({ href, children, onClick }: { href: string; children: React.ReactNode; onClick?: () => void }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    onClick={onClick}
    className="inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-0"
  >
    {children}
  </a>
);

const TextButton = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
  <button type="button" onClick={onClick} className="inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-0">
    {children}
  </button>
);

const ConnectWizard = ({ subscriptionUrl, onConnected, onOtherDevice, onClose }: ConnectWizardProps) => {
  const hereDevice = useMemo(() => detectHereDevice(), []);
  const here = platformOf(hereDevice);
  const desktop = useMemo(() => isDesktopBrowser(), []);
  // On a computer the first question is «этот компьютер или телефон?».
  const [target, setTarget] = useState<Target | null>(desktop ? null : "here");
  const [platform, setPlatform] = useState<WizardPlatform>(here);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [step, setStep] = useState<Step>("install");
  const [maybeNotOpened, setMaybeNotOpened] = useState(false);
  const [connected, setConnected] = useState(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const stepHeadingRef = useRef<HTMLParagraphElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const pollUntilRef = useRef(Date.now() + POLL_FOR_MS);

  const info = PLATFORMS.find((p) => p.id === platform) ?? PLATFORMS[0];
  const appleDevice = platform === "ios" || platform === "mac";
  // The waiting line appears once there is something to wait for.
  const waiting = target === "phone" || step === "sent";

  // ---- the device check ----
  const checkDevices = useCallback(async () => {
    const { data, error } = await apiGet<{ devices?: unknown[]; total?: number }>("/me/devices");
    if (error || !data) return;
    const total = typeof data.total === "number" ? data.total : Array.isArray(data.devices) ? data.devices.length : 0;
    if (total > 0) {
      setConnected(true);
      onConnectedRef.current(total);
    }
  }, []);

  useEffect(() => {
    if (connected) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || Date.now() > pollUntilRef.current) return;
      void checkDevices();
    }, POLL_MS);
    // Back from Happ or the App Store: check at once and keep checking for a while longer.
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      pollUntilRef.current = Date.now() + POLL_FOR_MS;
      void checkDevices();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [connected, checkDevices]);

  useEffect(() => () => {
    if (openTimerRef.current) window.clearTimeout(openTimerRef.current);
  }, []);

  // A new step replaces the pressed button: move focus to the step so keyboards and readers follow.
  const goTo = (next: Step) => {
    setStep(next);
    pollUntilRef.current = Date.now() + POLL_FOR_MS;
    window.setTimeout(() => stepHeadingRef.current?.focus(), 0);
  };

  const chooseTarget = (next: Target) => {
    setTarget(next);
    setMaybeNotOpened(false);
    goTo("install");
    if (next === "phone") track("qr_open");
  };

  const pickPlatform = (next: WizardPlatform) => {
    setPlatform(next);
    setPickerOpen(false);
    const nextIsComputer = PLATFORMS.find((p) => p.id === next)?.computer ?? false;
    if (next === here) chooseTarget("here");
    // From a phone a computer cannot scan a QR: send the visitor to the site on the computer.
    else if (nextIsComputer && !desktop) chooseTarget("computer");
    else chooseTarget("phone");
  };

  const addSubscription = () => {
    track("add_click");
    setMaybeNotOpened(false);
    goTo("sent");
    // Leaving the page (Happ opened) or the browser's «Открыть в Happ?» question (blur) count as
    // «it worked». Nothing at all for a few seconds: Happ is probably not installed. The step stays;
    // only a hint appears, so a slow answer to the browser's question does not undo anything.
    let away = false;
    const markAway = () => {
      away = true;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") away = true;
    };
    window.addEventListener("blur", markAway);
    window.addEventListener("pagehide", markAway);
    document.addEventListener("visibilitychange", onVisibility);
    window.location.href = BRAND.addLink(subscriptionUrl);
    if (openTimerRef.current) window.clearTimeout(openTimerRef.current);
    openTimerRef.current = window.setTimeout(() => {
      window.removeEventListener("blur", markAway);
      window.removeEventListener("pagehide", markAway);
      document.removeEventListener("visibilitychange", onVisibility);
      if (!away && document.visibilityState === "visible") setMaybeNotOpened(true);
    }, APP_OPEN_WAIT_MS);
  };

  if (connected) {
    return (
      <div className={`relative mb-6 w-full rounded-2xl ${BRAND.doneBoxClass} p-5 ring-2`} role="status">
        <button
          type="button"
          onClick={onClose}
          aria-label={C.close}
          className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-black/5"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-3 pr-6">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${BRAND.doneIconClass}`} aria-hidden="true">
            <Check className="h-5 w-5" />
          </span>
          <p className="font-bold text-foreground">{C.done}</p>
        </div>
      </div>
    );
  }

  const title =
    target === "phone"
      ? C.titlePhone
      : target === "computer"
        ? C.titleComputer
        : target === "here" && platform === here
          ? C.titleThis[hereDevice]
          : C.titleFirst;

  return (
    <section className="relative mb-6 w-full rounded-2xl bg-primary/10 p-4 ring-2 ring-primary/40 sm:p-5" aria-labelledby="connect-wizard-title">
      <button
        type="button"
        onClick={onClose}
        aria-label={C.hide}
        className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-black/5"
      >
        <X className="h-4 w-4" />
      </button>
      <h2 id="connect-wizard-title" className="pr-10 text-lg font-extrabold text-foreground">
        {title}
      </h2>
      <p className="mb-3 pr-10 text-sm text-muted-foreground">{C.subtitle}</p>

      {/* A computer: this computer or a phone? */}
      {target === null && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-12 justify-start gap-2 rounded-xl bg-card py-3 text-base font-semibold text-foreground"
            onClick={() => chooseTarget("here")}
          >
            <Monitor className="h-5 w-5 shrink-0" />
            {C.thisComputer}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-12 justify-start gap-2 rounded-xl bg-card py-3 text-base font-semibold text-foreground"
            onClick={() => chooseTarget("phone")}
          >
            <Smartphone className="h-5 w-5 shrink-0" />
            {C.phone}
          </Button>
        </div>
      )}

      {/* This device: install → add → turn on, one at a time. */}
      {target === "here" && (
        <div className="flex flex-col gap-2">
          {step === "install" ? (
            <div>
              <p ref={stepHeadingRef} tabIndex={-1} className="mb-2 text-sm font-semibold text-foreground outline-none">
                {C.stepInstall}
              </p>
              {appleDevice && (
                <p className="mb-2 text-sm text-muted-foreground">
                  {C.appleNote}{" "}
                  <a href={APPLE_REGION_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary hover:underline">
                    {C.appleNoteLink}
                  </a>
                </p>
              )}
              <Button asChild className="w-full rounded-full">
                <a
                  href={info.install}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    track("install_click");
                    goTo("add");
                  }}
                >
                  {C.installButton[platform]}
                </a>
              </Button>
              {platform === "android" && (
                <>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {C.androidWarning}
                  </p>
                  <SecondaryLink href={ANDROID_MIRROR_URL} onClick={() => track("install_click")}>
                    {C.androidMirror}
                  </SecondaryLink>
                </>
              )}
              <Button
                type="button"
                variant="outline"
                className="mt-2 w-full rounded-full bg-card font-semibold text-foreground"
                onClick={() => goTo("add")}
              >
                {C.alreadyInstalled}
              </Button>
            </div>
          ) : (
            <StepDone onChange={() => goTo("install")}>{C.downloaded}</StepDone>
          )}

          {step === "add" && (
            <div>
              <p ref={stepHeadingRef} tabIndex={-1} className="mb-2 text-sm font-semibold text-foreground outline-none">
                {C.stepAdd}
              </p>
              <Button type="button" className={`w-full rounded-full ${BRAND.actionClass}`} onClick={addSubscription}>
                {C.addButton}
              </Button>
              <TextButton onClick={() => goTo("install")}>{C.notInstalledBack}</TextButton>
            </div>
          )}

          {step === "sent" && (
            <>
              <div ref={stepHeadingRef} tabIndex={-1} className="outline-none">
                <StepDone onChange={() => goTo("add")}>{C.sent}</StepDone>
              </div>
              {maybeNotOpened && (
                <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-foreground ring-1 ring-amber-500/40" role="alert">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <div>
                    {C.notOpened}{" "}
                    <button type="button" onClick={addSubscription} className="font-semibold text-primary hover:underline">
                      {C.retry}
                    </button>{" "}
                    ·{" "}
                    <button type="button" onClick={() => goTo("install")} className="font-semibold text-primary hover:underline">
                      {C.install}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* A phone from a computer: install on the phone, then scan the QR in Happ. */}
      {target === "phone" && (
        <div className="flex flex-col gap-3">
          <div>
            <p ref={stepHeadingRef} tabIndex={-1} className="mb-1 text-sm font-semibold text-foreground outline-none">
              {C.phoneStepInstall}
            </p>
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">iPhone:</strong> {C.phoneIphone} (
              <a href={APPLE_REGION_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary hover:underline">
                {C.phoneIphoneLink}
              </a>
              ).
              <br />
              <strong className="text-foreground">Android:</strong> {C.phoneAndroid}
            </p>
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold text-foreground">{C.phoneStepScan}</p>
            <div className="flex justify-center rounded-xl bg-white p-3">
              <BRAND.Qr value={BRAND.qrValue(subscriptionUrl)} alt={C.qrAlt} />
            </div>
          </div>
        </div>
      )}

      {/* A computer from a phone: the phone cannot hand it the subscription. */}
      {target === "computer" && (
        <p ref={stepHeadingRef} tabIndex={-1} className="rounded-xl bg-card p-3 text-sm text-foreground outline-none ring-1 ring-border">
          {C.computerFromPhone}
        </p>
      )}

      {waiting && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {C.waiting}
        </p>
      )}

      {/* Another device */}
      <div className="mt-3 border-t border-primary/20 pt-1">
        <button
          type="button"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((v) => !v)}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary hover:underline"
        >
          {C.otherDevice}
          <ChevronDown className={`h-4 w-4 transition-transform ${pickerOpen ? "rotate-180" : ""}`} />
        </button>
        {pickerOpen && (
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(desktop ? PLATFORMS : PLATFORMS.filter((p) => !p.computer)).map((p) => {
              const Icon = ICONS[p.id];
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pickPlatform(p.id)}
                  className="flex min-h-11 items-center gap-2 rounded-xl bg-card px-3 py-2 text-left text-sm font-semibold text-foreground ring-1 ring-border hover:bg-primary/10"
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0">{p.label}</span>
                </button>
              );
            })}
            {!desktop && (
              <button
                type="button"
                onClick={() => chooseTarget("computer")}
                className="flex min-h-11 items-center gap-2 rounded-xl bg-card px-3 py-2 text-left text-sm font-semibold text-foreground ring-1 ring-border hover:bg-primary/10"
              >
                <Monitor className="h-4 w-4 shrink-0" />
                {C.computer}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                track("instructions_open");
                onOtherDevice();
              }}
              className="col-span-2 flex min-h-11 items-center justify-center rounded-xl bg-card px-3 py-2 text-sm font-semibold text-foreground ring-1 ring-border hover:bg-primary/10"
            >
              {C.tvAndOthers}
            </button>
          </div>
        )}
      </div>
    </section>
  );
};

export default ConnectWizard;
