import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { apiGet, apiPost } from "@/lib/api";
import { formatResendCooldownButtonLabel } from "@/lib/errorMessages";
import {
  authErrorMessage,
  codeAttemptsFrom,
  codeAttemptsHint,
  resendNotice,
  type CodeAttempts,
} from "@/lib/authMessages";
import { useSession } from "@/hooks/useSession";
import {
  consumeVpnPendingRedirect,
  peekVpnPendingRedirect,
  persistChatCompatCache,
  setPendingRefUuid,
  consumePendingRefUuid,
  peekPendingRefUuid,
  setVpnPendingRedirect,
  consumePendingPromoCode,
  normalizePromoCode,
  setPendingPromoCode,
} from "@/lib/vpnStorage";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import PasswordVisibilityButton from "@/components/PasswordVisibilityButton";
import { EmailTypoHint } from "@/components/EmailTypoHint";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/password";
import { readLastLoginEmail, rememberLoginEmail } from "@/lib/loginEmail";
import { clearLoginLinkToken, getLoginLinkToken } from "@/lib/loginLink";

import LandingShell from "@/pages/landing/LandingShell";
import LandingHeader from "@/pages/landing/LandingHeader";
import LandingFooter from "@/pages/landing/LandingFooter";
import LandingModal from "@/pages/landing/LandingModal";
import mascot220v from "@/assets/mascot-220v.png";
import { track } from "@/lib/funnel";
import { clearPendingLogin, inboxUrlFor, readPendingLogin, savePendingLogin } from "@/lib/pendingLogin";
import { cheapestPerMonth, formatRub, useTariffCards } from "@/lib/tariffPrices";
import LandingPlans, { PLAN_INCLUDES } from "@/pages/landing/LandingPlans";

/** Совпадает с ключом в Dashboard: отложенный query после входа с deep link */
const DASHBOARD_PENDING_SEARCH_KEY = "vpn_dashboard_pending_search";
const ALLOWED_DASHBOARD_DEEP_KEYS = new Set([
  "devices",
  "subscription",
  "buy",
  "instructions",
  "referral",
  "promo",
  "about",
]);

const OTP_SLOT_CLASS =
  "otp-slot h-[3.6rem] w-[3.6rem] rounded-md border border-input font-bold bg-white first:rounded-md last:rounded-md";

function hrefAfterLoginFromPendingSearch(): string {
  // 1) Универсальный pending redirect (сохраняется RequireVpnAuth при попытке
  //    открыть защищённую страницу без авторизации).
  const pending = consumeVpnPendingRedirect();
  if (pending) return pending;

  const pendingPromoCode = consumePendingPromoCode();
  if (pendingPromoCode) {
    return `/dashboard?promo=${encodeURIComponent(pendingPromoCode)}`;
  }

  // 2) Легаси: deep link на dashboard с query-параметрами.
  try {
    const search = sessionStorage.getItem(DASHBOARD_PENDING_SEARCH_KEY);
    sessionStorage.removeItem(DASHBOARD_PENDING_SEARCH_KEY);
    if (!search || search.length > 512 || !search.startsWith("?")) {
      return "/dashboard";
    }
    const sp = new URLSearchParams(search.slice(1));
    const keys = [...sp.keys()];
    if (keys.length === 0) {
      return "/dashboard";
    }
    for (const key of keys) {
      if (!ALLOWED_DASHBOARD_DEEP_KEYS.has(key)) {
        return "/dashboard";
      }
    }
    return `/dashboard${search}`;
  } catch {
    return "/dashboard";
  }
}

async function getBrowserFingerprint(): Promise<string> {
  try {
    const rawString = [
      navigator.userAgent || "",
      navigator.platform || "",
      screen.width || "",
      screen.height || "",
      screen.colorDepth || "",
      window.devicePixelRatio || "",
      navigator.language || "",
      navigator.hardwareConcurrency || "",
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory || "",
      Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    ].join("|");
    const msgBuffer = new TextEncoder().encode(rawString);
    const hashBuffer = await window.crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

type LoginStep = "email" | "password" | "verify";

/** A known delivery problem for the address (Unisender bounce), shown on the code screen. */
type DeliveryWarning = { category: string; message: string };

// After each send the code screen asks for bounces every 10 s for 2 minutes.
const DELIVERY_STATUS_POLL_MS = 10_000;
const DELIVERY_STATUS_MAX_POLLS = (2 * 60_000) / DELIVERY_STATUS_POLL_MS;

function asDeliveryWarning(value: unknown): DeliveryWarning | null {
  if (!value || typeof value !== "object") return null;
  const { category, message } = value as Record<string, unknown>;
  return typeof category === "string" && typeof message === "string" && message ? { category, message } : null;
}

/** Свёрнутая подсказка про поддержку под формой входа: вопрос-ссылка, по нажатию — текст. */
function SupportHint({
  open,
  onToggle,
  question,
  tip,
}: {
  open: boolean;
  onToggle: () => void;
  question: string;
  tip?: string;
}) {
  return (
    <div className="login-support-hint">
      <button type="button" className="login-support-hint__toggle" aria-expanded={open} onClick={onToggle}>
        {question}
      </button>
      {open ? (
        <p>
          {tip ? <>{tip} </> : null}
          Если доступа к почте нет, а аккаунт уже есть, напишите на{" "}
          <a href={SUPPORT_MAILTO} className="modal__link">
            {SUPPORT_EMAIL}
          </a>{" "}
          — после проверки поможем войти.
        </p>
      ) : null}
    </div>
  );
}

// Answers to what people ask support most; facts come from the RMW tariffs and the site settings.
const FAQ: { q: string; a: string }[] = [
  {
    q: "Сколько длится тест-драйв и что после него?",
    a: "Тест-драйв бесплатный и длится 6 часов — хватит, чтобы проверить скорость на своём телефоне и операторе. Карту для него привязывать не нужно. Понравится — выберите тариф в кабинете, доступ продолжится на тех же устройствах.",
  },
  {
    q: "Не приходит код на почту",
    a: "Загляните в «Спам» и «Промоакции» — письмо иногда попадает туда. Код действует 10 минут, подходит код из последнего письма. Мы работаем с крупными почтовыми сервисами: Gmail, Mail.ru, Яндекс, Rambler, iCloud, Outlook и другими.",
  },
  {
    q: "Какое приложение нужно?",
    a: "Бесплатное приложение Happ — для iPhone, Android, Windows и Mac. Ссылку на установку дадим в кабинете, подписка добавляется одной кнопкой.",
  },
  {
    q: "Сколько устройств можно подключить?",
    a: "До 7 устройств на одном аккаунте: телефон, ноутбук, планшет, компьютер — в любом сочетании.",
  },
  {
    q: "Что такое «Мобильная сеть» и её лимит?",
    a: "Это серверы, которые работают при ограничениях мобильного интернета. На них действует лимит 35 ГБ в месяц, остальные локации — без ограничений по трафику. Если не хватит, в кабинете можно докупить +20 или +50 ГБ.",
  },
  {
    q: "Что если перестанет работать?",
    a: "Напишите в чат поддержки в кабинете — отвечаем ежедневно с 05:00 до 01:00 МСК и быстро поможем.",
  },
];

// Pause after the last keystroke before the email typo hint appears.
const EMAIL_HINT_DELAY_MS = 800;

const Index = () => {
  useEffect(() => {
    track("landing_view", { once: true });
  }, []);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // «Не приходит код?» / «Забыли пароль?» — подсказка про поддержку свёрнута по умолчанию.
  const [supportHintOpen, setSupportHintOpen] = useState(false);
  // Токен из ссылки «Войти» в письме; адрес от него уже очищен (см. lib/loginLink).
  const [linkToken] = useState(getLoginLinkToken);
  // Подтверждение «Войти как iv***@gmail.com?»: ссылка срабатывает только по нажатию.
  const [linkConfirm, setLinkConfirm] = useState<{ maskedEmail: string } | null>(null);
  // Код, который уже отправляли на проверку: автопроверка не повторяет его после ошибки.
  const lastVerifiedCodeRef = useRef("");
  const [loginStep, setLoginStep] = useState<LoginStep>("email");
  // The typo hint shows once typing pauses or the field loses focus; it never blocks sending.
  const [emailSettled, setEmailSettled] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resendCooldownSec, setResendCooldownSec] = useState(0);
  // Attempt counters from the last wrong code; cleared when a new code is sent.
  const [codeAttempts, setCodeAttempts] = useState<CodeAttempts | null>(null);
  const [deliveryWarning, setDeliveryWarning] = useState<DeliveryWarning | null>(null);
  // Bumped on every successful send; restarts the delivery-status polling.
  const [deliveryPollId, setDeliveryPollId] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  // На мобильных устройствах между тапом и обновлением React-state (disabled
  // на кнопке) может пройти кадр — этого хватает, чтобы успеть зарегистрировать
  // двойной клик и улететь второй раз на /auth/send-code. Без guard первый
  // запрос успешно отправит письмо, второй упрётся в OTP-кулдаун (429) и
  // покажет пользователю «ошибку», хотя письмо уже пришло.
  const sendingRef = useRef(false);
  // The code screen was reopened from a pending login: the pending-redirect effect must not reset it.
  const restoredLoginRef = useRef(false);
  // The pending-login check runs once per page, even if the session effect runs again.
  const restoreCheckedRef = useRef(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh: refreshSession } = useSession();
  const { cards } = useTariffCards();
  const pricesRef = useRef<HTMLElement | null>(null);

  const normalizedEmail = email.trim().toLowerCase();
  const mailInbox = inboxUrlFor(normalizedEmail);

  useEffect(() => {
    if (emailSettled) return;
    const timer = window.setTimeout(() => setEmailSettled(true), EMAIL_HINT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [email, emailSettled]);

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    let changed = false;
    const ref = sp.get("ref");
    if (ref) {
      setPendingRefUuid(ref);
      getBrowserFingerprint().then((fingerprint) => {
        void apiPost("/ref/click", { ref_uuid: ref, fingerprint });
      }).catch(() => {
        void apiPost("/ref/click", { ref_uuid: ref });
      });

      sp.delete("ref");
      changed = true;
    }

    const promo = sp.get("promo");
    const promoCode = promo && promo !== "1" ? normalizePromoCode(promo) : "";
    if (promoCode) {
      setPendingPromoCode(promoCode);
      sp.delete("promo");
      changed = true;
    }

    if (changed) {
      const nextSearch = sp.toString();
      navigate(
        { pathname: location.pathname, search: nextSearch ? `?${nextSearch}` : "" },
        { replace: true },
      );
    }
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (linkToken) {
        const info = await apiPost<{ maskedEmail?: unknown }>("/auth/link-info", { token: linkToken });
        if (cancelled) return;
        if (!info.error && typeof info.data?.maskedEmail === "string") {
          setLinkConfirm({ maskedEmail: info.data.maskedEmail });
          setSessionReady(true);
          return;
        }
        clearLoginLinkToken();
        // Ссылка устарела или уже использована: если сессия есть, просто входим, иначе — окно входа.
        const me = await apiGet<{ user?: unknown }>("/me");
        if (cancelled) return;
        if (!me.error && me.data?.user) {
          navigate(hrefAfterLoginFromPendingSearch(), { replace: true });
          return;
        }
        setSessionReady(true);
        toast({
          title: "Ссылка не сработала",
          description: authErrorMessage(info, "Ссылка устарела. Запросите новый код"),
          variant: "destructive",
        });
        openLogin();
        return;
      }
      const { data, error } = await apiGet<{ user?: unknown }>("/me");
      if (cancelled) return;
      if (!error && data?.user) {
        navigate(hrefAfterLoginFromPendingSearch(), { replace: true });
        return;
      }
      track("landing_view_new", { once: true });
      // A code was sent a few minutes ago and the page was reloaded (back from the mail app):
      // open the code screen again instead of the landing.
      const pending = restoreCheckedRef.current ? null : readPendingLogin();
      restoreCheckedRef.current = true;
      if (pending) {
        restoredLoginRef.current = true;
        setEmail(pending.email);
        setEmailSettled(true);
        setLoginStep("verify");
        setResendCooldownSec(Math.max(0, 30 - Math.floor((Date.now() - pending.sentAt) / 1000)));
        setLoginOpen(true);
        track("code_screen_restored");
      }
      setSessionReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // Один раз при загрузке страницы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  useEffect(() => {
    if (!sessionReady || restoredLoginRef.current) return;
    if (peekVpnPendingRedirect()) {
      openLogin();
    }
  }, [sessionReady]);

  useEffect(() => {
    if (resendCooldownSec <= 0) return;
    const timer = window.setTimeout(() => {
      setResendCooldownSec((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [resendCooldownSec]);

  // Soft warning only: polling never blocks the code entry. It stops when a
  // warning arrives, after 2 minutes, or when the code screen goes away.
  useEffect(() => {
    if (!loginOpen || loginStep !== "verify" || deliveryPollId === 0 || !normalizedEmail) return;
    let cancelled = false;
    let timer: number | undefined;
    let polls = 0;
    const poll = async () => {
      timer = undefined;
      polls += 1;
      try {
        const { data } = await apiGet<{ warning?: unknown }>(
          `/auth/delivery-status?email=${encodeURIComponent(normalizedEmail)}`,
        );
        if (cancelled) return;
        const warning = asDeliveryWarning(data?.warning);
        if (warning) {
          setDeliveryWarning(warning);
          return;
        }
      } catch {
        if (cancelled) return;
      }
      if (polls < DELIVERY_STATUS_MAX_POLLS) {
        timer = window.setTimeout(() => void poll(), DELIVERY_STATUS_POLL_MS);
      }
    };
    timer = window.setTimeout(() => void poll(), DELIVERY_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [deliveryPollId, loginOpen, loginStep, normalizedEmail]);

  // «Долистали до тарифов»: once, when the price section is half on screen.
  useEffect(() => {
    const node = pricesRef.current;
    if (!sessionReady || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          track("pricing_view", { once: true });
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [sessionReady]);

  const backToEmailStep = () => {
    setCode("");
    resetPasswordFields();
    setDeliveryWarning(null);
    setLoginStep("email");
  };

  const resetPasswordFields = () => {
    setPassword("");
    setShowPassword(false);
    setSupportHintOpen(false);
  };

  // Fix from the code screen: back to the email step with the corrected address.
  const applyEmailFixFromCodeStep = (fixed: string) => {
    setEmail(fixed);
    setEmailSettled(true);
    setCode("");
    resetPasswordFields();
    setCodeAttempts(null);
    setDeliveryWarning(null);
    setLoginStep("email");
  };

  const openLogin = () => {
    track("login_open");
    setLoginStep("email");
    setCode("");
    resetPasswordFields();
    setEmail((current) => current || readLastLoginEmail());
    setResendCooldownSec(0);
    setCodeAttempts(null);
    setDeliveryWarning(null);
    setLoginOpen(true);
  };

  const openLoginFromHeader = () => {
    track("header_login");
    openLogin();
  };

  const handleSelectTariff = (months: number) => {
    track("plan_select");
    setVpnPendingRedirect(`/tariff/pay?months=${months}`);
    openLogin();
  };

  const closeLogin = () => {
    if (loading) return;
    clearPendingLogin();
    restoredLoginRef.current = false;
    setCode("");
    resetPasswordFields();
    setResendCooldownSec(0);
    setLoginOpen(false);
  };

  const handleSendCode = async () => {
    if (sendingRef.current) return;
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      toast({ title: "Ошибка", description: "Укажите корректный email", variant: "destructive" });
      return;
    }

    sendingRef.current = true;
    setLoading(true);
    try {
      const refUuid = peekPendingRefUuid();
      const sendCodeBody: { email: string; ref_uuid?: string; fingerprint?: string } = {
        email: normalizedEmail,
      };
      if (refUuid) {
        sendCodeBody.ref_uuid = refUuid;
        const fingerprint = await getBrowserFingerprint();
        if (fingerprint) {
          sendCodeBody.fingerprint = fingerprint;
        }
      }

      const result = await apiPost<{
        ok?: boolean;
        error?: string;
        retryAfterSec?: number;
        sendNumber?: number;
        deliveryWarning?: unknown;
      }>(
        "/auth/send-code",
        sendCodeBody,
      );
      const { data, error, retryAfterSec } = result;

      if (error) {
        // A 429 holds the resend button for exactly as long as the server refuses a new code.
        if (retryAfterSec) {
          setResendCooldownSec(retryAfterSec);
        }
        // The cooldown means a code went to this address moments ago and still works:
        // show the code screen instead of an error.
        const errorCode = (data as { code?: unknown } | null | undefined)?.code;
        if (result.status === 429 && errorCode === "otp_cooldown") {
          setCode("");
          lastVerifiedCodeRef.current = "";
          setLoginStep("verify");
          savePendingLogin(normalizedEmail);
          toast({
            title: "Код уже отправлен",
            description: `Проверьте почту ${normalizedEmail} — подойдёт код из последнего письма`,
            className: "bg-[#0a0a0a] text-white border-green-500 shadow-[inset_4px_0_0_0_#22c55e]",
          });
          return;
        }
        toast({ title: "Ошибка", description: authErrorMessage(result, "Не удалось отправить код"), variant: "destructive" });
        return;
      }

      if (data?.ok) {
        setCode("");
        lastVerifiedCodeRef.current = "";
        setCodeAttempts(null);
        setDeliveryWarning(asDeliveryWarning(data.deliveryWarning));
        setDeliveryPollId((id) => id + 1);
        setLoginStep("verify");
        savePendingLogin(normalizedEmail);
        setResendCooldownSec(retryAfterSec ?? data.retryAfterSec ?? 30);
        toast({
          title: "✅ Код отправлен!",
          description: resendNotice(data.sendNumber) || `Код уже летит на ${normalizedEmail}`,
          className: "bg-[#0a0a0a] text-white border-green-500 shadow-[inset_4px_0_0_0_#22c55e]",
        });
      } else {
        toast({ title: "Ошибка", description: data?.error || "Не удалось отправить код", variant: "destructive" });
      }
    } catch (err: unknown) {
      toast({ title: "Ошибка", description: err instanceof Error ? err.message : "Ошибка отправки", variant: "destructive" });
    } finally {
      sendingRef.current = false;
      setLoading(false);
    }
  };

  const completeLogin = async (refUuid?: string | null) => {
    if (refUuid) {
      consumePendingRefUuid();
    }
    clearPendingLogin();
    persistChatCompatCache({ email: normalizedEmail });
    rememberLoginEmail(normalizedEmail);
    await refreshSession();
    navigate(hrefAfterLoginFromPendingSearch());
  };

  // Сначала узнаём способ входа: если у аккаунта есть пароль — показываем шаг
  // пароля, иначе отправляем код как раньше. Ошибка проверки не блокирует вход
  // по коду.
  const handleStart = async () => {
    if (sendingRef.current) return;
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      toast({ title: "Ошибка", description: "Укажите корректный email", variant: "destructive" });
      return;
    }

    sendingRef.current = true;
    setLoading(true);
    let accountHasPassword = false;
    try {
      const { data, error } = await apiPost<{ hasPassword?: boolean }>("/auth/method", { email: normalizedEmail });
      accountHasPassword = !error && Boolean(data?.hasPassword);
    } catch {
      accountHasPassword = false;
    } finally {
      sendingRef.current = false;
      setLoading(false);
    }

    resetPasswordFields();
    if (accountHasPassword) {
      setLoginStep("password");
      return;
    }
    await handleSendCode();
  };

  const handlePasswordLogin = async () => {
    if (!password) {
      toast({ title: "Ошибка", description: "Введите пароль", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const result = await apiPost<{ user?: unknown; error?: string }>("/auth/login-password", {
        email: normalizedEmail,
        password,
      });
      const { data, error } = result;
      if (error) throw new Error(authErrorMessage(result, "Не удалось завершить вход"));
      if (!data?.user) throw new Error(data?.error || "Не удалось завершить вход");
      setPassword("");
      await completeLogin();
    } catch (err: unknown) {
      toast({ title: "Ошибка", description: err instanceof Error ? err.message : "Ошибка входа", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!code || code.length < 5) {
      toast({ title: "Ошибка", description: "Введите код подтверждения", variant: "destructive" });
      return;
    }

    lastVerifiedCodeRef.current = code;
    setLoading(true);
    try {
      const refUuid = peekPendingRefUuid();
      const verifyBody: {
        email: string;
        code: string;
        ref_uuid?: string;
        fingerprint?: string;
      } = {
        email: normalizedEmail,
        code,
      };
      if (refUuid) {
        verifyBody.ref_uuid = refUuid;
        const fingerprint = await getBrowserFingerprint();
        if (fingerprint) {
          verifyBody.fingerprint = fingerprint;
        }
      }

      const result = await apiPost<{ user?: unknown; error?: string }>("/auth/verify", verifyBody);
      const { data, error } = result;

      if (error) {
        // A wrong code comes with "Попыток осталось: X из 5"; any other answer drops the counter.
        setCodeAttempts(result.status === 400 ? codeAttemptsFrom(result) : null);
        throw new Error(authErrorMessage(result, "Ошибка проверки кода"));
      }

      if (data?.user) {
        resetPasswordFields();
        await completeLogin(refUuid);
      } else {
        toast({ title: "Ошибка", description: data?.error || "Неверный код", variant: "destructive" });
      }
    } catch (err: unknown) {
      toast({ title: "Ошибка", description: err instanceof Error ? err.message : "Ошибка проверки кода", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleLinkLogin = async () => {
    if (!linkToken || loading) return;
    setLoading(true);
    try {
      const refUuid = peekPendingRefUuid();
      const body: { token: string; ref_uuid?: string; fingerprint?: string } = { token: linkToken };
      if (refUuid) {
        body.ref_uuid = refUuid;
        const fingerprint = await getBrowserFingerprint();
        if (fingerprint) body.fingerprint = fingerprint;
      }
      const result = await apiPost<{ user?: unknown; loginEmail?: unknown }>("/auth/verify-link", body);
      clearLoginLinkToken();
      if (result.error || !result.data?.user) {
        setLinkConfirm(null);
        toast({
          title: "Ссылка не сработала",
          description: authErrorMessage(result, "Ссылка устарела. Запросите новый код"),
          variant: "destructive",
        });
        openLogin();
        return;
      }
      if (refUuid) consumePendingRefUuid();
      clearPendingLogin();
      const linkEmail = typeof result.data.loginEmail === "string" ? result.data.loginEmail : "";
      if (linkEmail) {
        rememberLoginEmail(linkEmail);
        persistChatCompatCache({ email: linkEmail });
      }
      await refreshSession();
      navigate(hrefAfterLoginFromPendingSearch(), { replace: true });
    } catch (err: unknown) {
      toast({ title: "Ошибка", description: err instanceof Error ? err.message : "Ошибка входа", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const cancelLinkLogin = () => {
    if (loading) return;
    clearLoginLinkToken();
    setLinkConfirm(null);
  };

  // Пятая цифра — сразу проверяем код, без нажатия кнопки. Тот же код после ошибки
  // повторно не отправляем: пользователь его исправит или нажмёт «Войти».
  useEffect(() => {
    if (loginStep !== "verify" || code.length < 5 || loading) return;
    if (code === lastVerifiedCodeRef.current) return;
    void handleVerify();
    // handleVerify пересоздаётся на каждом рендере; реагируем только на ввод кода.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, loginStep]);

  if (!sessionReady) {
    return (
      <div className="flex min-h-[100svh] min-h-[100dvh] items-center justify-center bg-background">
        <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" aria-label="Загрузка" />
      </div>
    );
  }

  return (
    <LandingShell>
      <LandingHeader
        nav={
          <>
            <a href="#how" className="nav__link">
              Как подключить
            </a>
            <a href="#prices" className="nav__link">
              Цены
            </a>
            <a href="#faq" className="nav__link">
              Вопросы
            </a>
            <button type="button" className="nav__link" onClick={() => setSupportOpen(true)}>
              Поддержка
            </button>
          </>
        }
        cta={
          <button type="button" className="btn btn--ghost" onClick={openLoginFromHeader}>
            Войти
          </button>
        }
        mobileCta={
          <button type="button" className="btn btn--ghost header__mobile-login" aria-label="Войти в аккаунт" onClick={openLoginFromHeader}>
            Войти
          </button>
        }
      />

      <main>
        <section className="hero hero--offer">
          <div className="container hero__grid">
            <div className="hero__content">
              <h1 className="hero__title">
                <span className="hero__line">Включитесь</span>{" "}
                <span className="accent hero__line">На все 220</span>
              </h1>
              <p className="hero__desc hero__desc--wide">
                Быстрый защищённый интернет для телефона и компьютера. Настройка за пару минут.
              </p>
              <ul className="hero__checks" role="list">
                <li>
                  <span className="hero__tick" aria-hidden="true">✓</span>
                  Безлимитный трафик*
                </li>
                <li>
                  <span className="hero__tick" aria-hidden="true">✓</span>
                  16 стран
                </li>
                <li>
                  <span className="hero__tick" aria-hidden="true">✓</span>
                  До 7 устройств
                </li>
                <li>
                  <span className="hero__tick" aria-hidden="true">✓</span>
                  Поддержка без выходных
                </li>
              </ul>
              <div className="hero__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--lg hero__cta"
                  onClick={() => {
                    track("landing_cta");
                    openLogin();
                  }}
                >
                  <svg viewBox="0 0 24 24" className="btn__icon" aria-hidden="true">
                    <path d="M13 2 L4 14 h7 l-2 8 l9-12 h-7 l2-8 Z" fill="currentColor" />
                  </svg>
                  Попробовать 6 часов бесплатно
                </button>
                <a href="#prices" className="hero__price-link">
                  Тарифы — от {formatRub(cheapestPerMonth(cards))} ₽ в месяц ↓
                </a>
              </div>
              <p className="hero__note hero__note--wide">Без карты. Код для входа придёт на почту.</p>
            </div>

            <div className="hero__visual">
              <div className="hero__mascot-glow" aria-hidden="true" />
              <img
                src={mascot220v}
                alt="Маскот 220v"
                className="hero__mascot"
                width={1024}
                height={1536}
                decoding="async"
                fetchPriority="high"
              />
            </div>
          </div>
        </section>

        <section className="landing-section" id="how" aria-labelledby="how-title">
          <div className="container">
            <h2 className="landing-section__title" id="how-title">
              Подключение в три шага
            </h2>
            <ol className="steps" role="list">
              <li className="step">
                <span className="step__num">1</span>
                <h3 className="step__title">Введите email</h3>
                <p className="step__desc">Пришлём код для входа. Аккаунт и тест-драйв появятся сразу.</p>
              </li>
              <li className="step">
                <span className="step__num">2</span>
                <h3 className="step__title">Установите Happ</h3>
                <p className="step__desc">Кабинет даст ссылку для вашего телефона или компьютера.</p>
              </li>
              <li className="step">
                <span className="step__num">3</span>
                <h3 className="step__title">Нажмите «Добавить»</h3>
                <p className="step__desc">Подписка сама появится в Happ — включайте и пользуйтесь.</p>
              </li>
            </ol>
            <div className="landing-section__cta">
              <button
                type="button"
                className="btn btn--primary btn--lg"
                onClick={() => {
                  track("landing_cta");
                  openLogin();
                }}
              >
                Начать тест-драйв
              </button>
            </div>
          </div>
        </section>

        <section className="landing-section" id="prices" ref={pricesRef} aria-labelledby="prices-title">
          <div className="container">
            <h2 className="landing-section__title" id="prices-title">
              Тарифы
            </h2>
            <p className="landing-section__subtitle">Чем дольше срок, тем дешевле месяц. Сначала можно бесплатно попробовать.</p>
            <p className="plans-includes">В каждом тарифе: {PLAN_INCLUDES}</p>
            <LandingPlans cards={cards} onSelect={handleSelectTariff} />
            <p className="price-page__note">
              * Безлимит на всех локациях, кроме серверов «Мобильная сеть» — там 35 ГБ в месяц. Подробнее — в{" "}
              <a href="/terms" className="modal__link">
                условиях использования
              </a>
              .
            </p>
          </div>
        </section>

        <section className="landing-section" id="faq" aria-labelledby="faq-title">
          <div className="container container--narrow">
            <h2 className="landing-section__title" id="faq-title">
              Частые вопросы
            </h2>
            <div className="faq">
              {FAQ.map((item) => (
                <details
                  key={item.q}
                  className="faq__item"
                  onToggle={(e) => {
                    if ((e.currentTarget as HTMLDetailsElement).open) track("faq_open");
                  }}
                >
                  <summary className="faq__q">{item.q}</summary>
                  <div className="faq__a">{item.a}</div>
                </details>
              ))}
            </div>
            <div className="landing-section__cta">
              <button
                type="button"
                className="btn btn--primary btn--lg"
                onClick={() => {
                  track("landing_cta");
                  openLogin();
                }}
              >
                Попробовать бесплатно
              </button>
              <p className="hero__note">Остались вопросы — напишите в чат поддержки после входа.</p>
            </div>
          </div>
        </section>
      </main>

      <LandingFooter />

      {/* Support modal */}
      <LandingModal open={supportOpen} onClose={() => setSupportOpen(false)} title="Поддержка">
        <p>
          По любым вопросам напишите нам на почту{" "}
          <a href="mailto:support@220v.shop" className="modal__link">
            support@220v.shop
          </a>
          {", также вы можете написать нам в чат на сайте, для этого необходимо авторизоваться."}
        </p>
        <p>Работаем ежедневно: 05:00–01:00 МСК</p>
      </LandingModal>

      {/* Confirm login by the emailed link */}
      <LandingModal
        open={Boolean(linkConfirm)}
        onClose={cancelLinkLogin}
        title="Вход в 220v"
        subtitle={
          <>
            Войти в аккаунт <b className="login-sent-email">{linkConfirm?.maskedEmail}</b>?
          </>
        }
      >
        <div className="login-card" style={{ background: "transparent", border: 0, padding: 0, boxShadow: "none" }}>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--primary btn--wide"
              onClick={() => void handleLinkLogin()}
              disabled={loading}
            >
              {loading ? "Входим..." : "Войти"}
            </button>
            <button type="button" className="btn btn--ghost btn--wide" onClick={cancelLinkLogin} disabled={loading}>
              Это не мой аккаунт
            </button>
          </div>
        </div>
      </LandingModal>

      {/* Login modal */}
      <LandingModal
        open={loginOpen}
        onClose={closeLogin}
        title={loginStep === "email" ? "Вход в 220v" : loginStep === "password" ? "Введите пароль" : "Введите код"}
        subtitle={
          loginStep === "email"
            ? "Пришлём на почту код и ссылку для входа"
            : loginStep === "password"
              ? `Пароль для ${normalizedEmail}`
              : (
                  <>
                    Отправили на <b className="login-sent-email login-sent-email--line">
                      {/* Break a long address before "@", not in the middle of the domain. */}
                      {normalizedEmail.split("@")[0]}<wbr />{normalizedEmail.includes("@") ? `@${normalizedEmail.split("@").slice(1).join("@")}` : ""}
                    </b>
                    Введите код или нажмите «Войти» в письме
                  </>
                )
        }
      >
        {loginStep === "email" ? (
          <div className="login-card" style={{ background: "transparent", border: 0, padding: 0, boxShadow: "none" }}>
            <div className="form-field">
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                name="email"
                type="email"
                inputMode="email"
                placeholder="you@example.com"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="send"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailSettled(false);
                }}
                onBlur={() => setEmailSettled(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleStart();
                }}
                disabled={loading}
              />
              {emailSettled ? (
                <EmailTypoHint
                  email={email}
                  onApply={setEmail}
                  disabled={loading}
                  className="login-typo-hint"
                />
              ) : null}
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn--primary btn--wide"
                onClick={() => void handleStart()}
                disabled={loading}
              >
                {loading ? "Отправка..." : "Продолжить"}
              </button>
            </div>
          </div>
        ) : loginStep === "password" ? (
          <form
            className="login-card"
            style={{ background: "transparent", border: 0, padding: 0, boxShadow: "none" }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!loading) void handlePasswordLogin();
            }}
          >
            <input type="email" name="email" autoComplete="username" value={normalizedEmail} readOnly hidden />
            <div className="form-field">
              <label htmlFor="login-password">Пароль</label>
              <div className="password-field">
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Пароль"
                  enterKeyHint="go"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  autoFocus
                />
                <PasswordVisibilityButton
                  visible={showPassword}
                  onClick={() => setShowPassword(!showPassword)}
                  disabled={loading}
                />
              </div>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn--primary btn--wide" disabled={loading || !password}>
                {loading ? "Проверка..." : "Войти"}
              </button>
            </div>
            <p className="form-link">
              <button
                type="button"
                onClick={() => {
                  setPassword("");
                  void handleSendCode();
                }}
                disabled={loading || resendCooldownSec > 0}
              >
                {resendCooldownSec > 0
                  ? formatResendCooldownButtonLabel(resendCooldownSec)
                  : "Войти по коду из email"}
              </button>
            </p>
            <p className="form-link">
              <button
                type="button"
                onClick={() => {
                  resetPasswordFields();
                  setLoginStep("email");
                }}
                disabled={loading}
              >
                ← Изменить email
              </button>
            </p>
            <SupportHint
              open={supportHintOpen}
              onToggle={() => setSupportHintOpen((v) => !v)}
              question="Забыли пароль и нет доступа к почте?"
            />
          </form>
        ) : (
          <div className="login-card" style={{ background: "transparent", border: 0, padding: 0, boxShadow: "none" }}>
            {deliveryWarning ? (
              <div className="login-delivery-warning" role="alert" data-testid="delivery-warning">
                <p>{deliveryWarning.message}</p>
                <button type="button" onClick={backToEmailStep} disabled={loading}>
                  Изменить почту
                </button>
              </div>
            ) : null}
            <EmailTypoHint
              email={normalizedEmail}
              onApply={applyEmailFixFromCodeStep}
              disabled={loading}
              className="login-typo-hint login-typo-hint--code"
            />
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
              <InputOTP
                maxLength={5}
                value={code}
                onChange={setCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                pushPasswordManagerStrategy="none"
                autoFocus
                disabled={loading}
              >
                <InputOTPGroup className="login-otp-group gap-3">
                  {[0, 1, 2, 3, 4].map((index) => (
                    <InputOTPSlot key={index} index={index} className={OTP_SLOT_CLASS} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>
            {codeAttempts ? (
              <p className="login-attempts-hint" role="status">
                {codeAttemptsHint(codeAttempts)}
              </p>
            ) : null}
            <div className="form-actions">
              <button
                type="button"
                className="btn btn--primary btn--wide"
                onClick={handleVerify}
                disabled={loading || code.length < 5}
              >
                {loading ? "Проверка..." : "Войти"}
              </button>
            </div>
            <p className="form-link login-code-links">
              <button
                type="button"
                onClick={() => {
                  void handleSendCode();
                }}
                disabled={loading || resendCooldownSec > 0}
              >
                {resendCooldownSec > 0
                  ? formatResendCooldownButtonLabel(resendCooldownSec)
                  : "Отправить ещё раз"}
              </button>
              <button type="button" onClick={backToEmailStep} disabled={loading}>
                Изменить почту
              </button>
            </p>
            <div className="login-mail-hint" data-testid="login-mail-hint">
              <p>
                Нет письма? Загляните в «Спам» и «Промоакции». Код действует 10 минут — подходит из последнего письма.
              </p>
              {mailInbox ? (
                <a
                  className="btn btn--ghost btn--wide login-mail-hint__open"
                  href={mailInbox.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => track("mail_open_click")}
                >
                  Открыть {mailInbox.name}
                </a>
              ) : null}
            </div>
            <SupportHint
              open={supportHintOpen}
              onToggle={() => setSupportHintOpen((v) => !v)}
              question="Письмо так и не пришло?"
            />
          </div>
        )}
      </LandingModal>
    </LandingShell>
  );
};

export default Index;
