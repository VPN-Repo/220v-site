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
import { isValidNewPassword, PASSWORD_REQUIREMENTS, SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/password";

import LandingShell from "@/pages/landing/LandingShell";
import LandingHeader from "@/pages/landing/LandingHeader";
import LandingFooter from "@/pages/landing/LandingFooter";
import LandingModal from "@/pages/landing/LandingModal";
import mascot220v from "@/assets/mascot-220v.png";

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

// Pause after the last keystroke before the email typo hint appears.
const EMAIL_HINT_DELAY_MS = 800;

const Index = () => {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [settingPassword, setSettingPassword] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loginStep, setLoginStep] = useState<LoginStep>("email");
  // The typo hint shows once typing pauses or the field loses focus; it never blocks sending.
  const [emailSettled, setEmailSettled] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resendCooldownSec, setResendCooldownSec] = useState(0);
  // Attempt counters from the last wrong code; cleared when a new code is sent.
  const [codeAttempts, setCodeAttempts] = useState<CodeAttempts | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  // На мобильных устройствах между тапом и обновлением React-state (disabled
  // на кнопке) может пройти кадр — этого хватает, чтобы успеть зарегистрировать
  // двойной клик и улететь второй раз на /auth/send-code. Без guard первый
  // запрос успешно отправит письмо, второй упрётся в OTP-кулдаун (429) и
  // покажет пользователю «ошибку», хотя письмо уже пришло.
  const sendingRef = useRef(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh: refreshSession } = useSession();

  const normalizedEmail = email.trim().toLowerCase();

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
      const { data, error } = await apiGet<{ user?: unknown }>("/me");
      if (cancelled) return;
      if (!error && data?.user) {
        navigate(hrefAfterLoginFromPendingSearch(), { replace: true });
        return;
      }
      setSessionReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  useEffect(() => {
    if (!sessionReady) return;
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

  const resetPasswordFields = () => {
    setPassword("");
    setNewPassword("");
    setRepeatPassword("");
    setSettingPassword(false);
    setShowPassword(false);
  };

  // Fix from the code screen: back to the email step with the corrected address.
  const applyEmailFixFromCodeStep = (fixed: string) => {
    setEmail(fixed);
    setEmailSettled(true);
    setCode("");
    resetPasswordFields();
    setCodeAttempts(null);
    setLoginStep("email");
  };

  const openLogin = () => {
    setLoginStep("email");
    setCode("");
    resetPasswordFields();
    setHasPassword(false);
    setResendCooldownSec(0);
    setCodeAttempts(null);
    setLoginOpen(true);
  };

  const handleSelectTariff = (months: number) => {
    setVpnPendingRedirect(`/tariff/pay?months=${months}`);
    setPricingOpen(false);
    openLogin();
  };

  const closeLogin = () => {
    if (loading) return;
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

      const result = await apiPost<{ ok?: boolean; error?: string; retryAfterSec?: number; sendNumber?: number }>(
        "/auth/send-code",
        sendCodeBody,
      );
      const { data, error, retryAfterSec } = result;

      if (error) {
        // A 429 holds the resend button for exactly as long as the server refuses a new code.
        if (retryAfterSec) {
          setResendCooldownSec(retryAfterSec);
        }
        toast({ title: "Ошибка", description: authErrorMessage(result, "Не удалось отправить код"), variant: "destructive" });
        return;
      }

      if (data?.ok) {
        setCode("");
        setCodeAttempts(null);
        setLoginStep("verify");
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
    persistChatCompatCache({ email: normalizedEmail });
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

    setHasPassword(accountHasPassword);
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
    if (settingPassword && !isValidNewPassword(newPassword)) {
      toast({ title: "Ошибка", description: PASSWORD_REQUIREMENTS, variant: "destructive" });
      return;
    }
    if (settingPassword && newPassword !== repeatPassword) {
      toast({ title: "Ошибка", description: "Пароли не совпадают", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const refUuid = peekPendingRefUuid();
      const verifyBody: {
        email: string;
        code: string;
        ref_uuid?: string;
        fingerprint?: string;
        newPassword?: string;
      } = {
        email: normalizedEmail,
        code,
      };
      if (settingPassword) {
        verifyBody.newPassword = newPassword;
      }
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
            <button type="button" className="nav__link" onClick={() => setAboutOpen(true)}>
              О нас
            </button>
            <button type="button" className="nav__link" onClick={() => setPricingOpen(true)}>
              Цены
            </button>
            <button type="button" className="nav__link" onClick={() => setSupportOpen(true)}>
              Поддержка
            </button>
          </>
        }
        cta={
          <button type="button" className="btn btn--ghost" onClick={openLogin}>
            Войти
          </button>
        }
      />

      <main>
        <section className="hero">
          <div className="container hero__grid">
            <div className="hero__content">
              <h1 className="hero__title">
                Оставайтесь{" "}
                <br />
                <span className="accent">невидимыми</span>{" "}
                <br />
                для посторонних{" "}
                <br />
                с <span className="accent">220v</span>
              </h1>
              <p className="hero__desc">
                Мы надёжно скрываем ваши данные{" "}
                <br />
                и шифруем каждое действие в сети.{" "}
                <br />
                Один сервис для безопасности{" "}
                <br />
                всех ваших гаджетов.
              </p>
              <button type="button" className="btn btn--primary btn--lg" onClick={openLogin}>
                <svg viewBox="0 0 24 24" className="btn__icon" aria-hidden="true">
                  <path d="M13 2 L4 14 h7 l-2 8 l9-12 h-7 l2-8 Z" fill="currentColor" />
                </svg>
                Регистрация в 220v
              </button>
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

          <div className="container">
            <ul className="features" role="list">
              <li className="feature">
                <span className="feature__icon" aria-hidden="true">
                  <svg viewBox="0 0 32 32" fill="none">
                    <path
                      d="M16 3 4 7v9c0 7 5 12 12 13 7-1 12-6 12-13V7l-12-4Z"
                      stroke="#C6FF3D"
                      strokeWidth="2"
                      strokeLinejoin="round"
                    />
                    <path
                      d="m11 16 4 4 7-8"
                      stroke="#C6FF3D"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <h3 className="feature__title">Безопасно</h3>
                <p className="feature__desc">
                  Ваши данные{" "}
                  <br />
                  под защитой
                </p>
              </li>
              <li className="feature">
                <span className="feature__icon" aria-hidden="true">
                  <svg viewBox="0 0 32 32" fill="none">
                    <path d="M18 3 6 18h7l-3 11 12-15h-7l3-11Z" stroke="#C6FF3D" strokeWidth="2" strokeLinejoin="round" />
                  </svg>
                </span>
                <h3 className="feature__title">Быстро</h3>
                <p className="feature__desc">
                  Высокая скорость{" "}
                  <br />
                  без ограничений
                </p>
              </li>
              <li className="feature">
                <span className="feature__icon" aria-hidden="true">
                  <svg viewBox="0 0 32 32" fill="none">
                    <circle cx="16" cy="16" r="13" stroke="#C6FF3D" strokeWidth="2" />
                    <path
                      d="M3 16h26M16 3c3.5 4 5.5 8 5.5 13s-2 9-5.5 13c-3.5-4-5.5-8-5.5-13S12.5 7 16 3Z"
                      stroke="#C6FF3D"
                      strokeWidth="2"
                    />
                  </svg>
                </span>
                <h3 className="feature__title">Свободно</h3>
                <p className="feature__desc">
                  Доступ к любому{" "}
                  <br />
                  контенту
                </p>
              </li>
              <li className="feature">
                <span className="feature__icon" aria-hidden="true">
                  <svg viewBox="0 0 32 32" fill="none">
                    <path
                      d="M12 3v7M20 3v7M8 10h16v6a8 8 0 0 1-8 8 8 8 0 0 1-8-8v-6ZM16 24v5"
                      stroke="#C6FF3D"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <h3 className="feature__title">Всегда на связи</h3>
                <p className="feature__desc">
                  220v — энергия{" "}
                  <br />
                  свободы в интернете
                </p>
              </li>
            </ul>
          </div>
        </section>
      </main>

      <LandingFooter />

      {/* About modal */}
      <LandingModal open={aboutOpen} onClose={() => setAboutOpen(false)} title="О нас">
        <p>
          Опираясь на многолетний опыт управления серверами, наша команда разработала сервис для создания защищённых
          интернет-туннелей.
        </p>
        <p>
          Мы понимаем все тонкости маршрутизации и выстраивания анонимных соединений. Наш приоритет — чтобы трафик
          клиентов всегда шёл к нужным ресурсам по оптимальным и безопасным путям.
        </p>
        <p>
          Мы лично пользуемся своей разработкой каждый день, на 100% уверены в её качестве и с гордостью предлагаем её
          вам!
        </p>
      </LandingModal>

      {/* Pricing modal */}
      <LandingModal
        open={pricingOpen}
        onClose={() => setPricingOpen(false)}
        title="Тарифы"
        subtitle="Выберите срок — чем дольше, тем выгоднее"
        wide
      >
        <div className="plans">
          <div className="plan">
            <div className="plan__head">
              <h3 className="plan__name">1 месяц</h3>
            </div>
            <div className="plan__price">
              <span className="plan__amount">450</span>
              <span className="plan__currency">₽</span>
            </div>
            <p className="plan__period">за 1 месяц</p>
            <ul className="plan__features" role="list">
              <li>Все локации</li>
              <li>Безлимитный трафик*</li>
              <li>Работаем ежедневно: 05:00–01:00 МСК</li>
            </ul>
            <button
              type="button"
              className="btn btn--ghost btn--wide plan__btn"
              onClick={() => handleSelectTariff(1)}
            >
              Выбрать
            </button>
          </div>

          <div className="plan plan--featured">
            <span className="plan__badge">-15%</span>
            <div className="plan__head">
              <h3 className="plan__name">6 месяцев</h3>
            </div>
            <div className="plan__price">
              <span className="plan__amount">2 295</span>
              <span className="plan__currency">₽</span>
            </div>
            <p className="plan__period">≈ 382 ₽ / месяц</p>
            <ul className="plan__features" role="list">
              <li>Все локации</li>
              <li>Безлимитный трафик*</li>
              <li>Работаем ежедневно: 05:00–01:00 МСК</li>
              <li>Экономия 15%</li>
            </ul>
            <button
              type="button"
              className="btn btn--primary btn--wide plan__btn"
              onClick={() => handleSelectTariff(6)}
            >
              Выбрать
            </button>
          </div>

          <div className="plan">
            <span className="plan__badge plan__badge--alt">-30%</span>
            <div className="plan__head">
              <h3 className="plan__name">1 год</h3>
            </div>
            <div className="plan__price">
              <span className="plan__amount">3 780</span>
              <span className="plan__currency">₽</span>
            </div>
            <p className="plan__period">≈ 315 ₽ / месяц</p>
            <ul className="plan__features" role="list">
              <li>Все локации</li>
              <li>Безлимитный трафик*</li>
              <li>Приоритетная поддержка</li>
              <li>Максимальная выгода — 30%</li>
            </ul>
            <button
              type="button"
              className="btn btn--ghost btn--wide plan__btn"
              onClick={() => handleSelectTariff(12)}
            >
              Выбрать
            </button>
          </div>
        </div>

        <p className="modal__note">
          * На серверах категории «Мобильная сеть» действует лимит 10 ГБ в месяц. Подробнее — в{" "}
          <a href="/terms" className="modal__link">
            условиях использования
          </a>
          .
        </p>
      </LandingModal>

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

      {/* Login modal */}
      <LandingModal
        open={loginOpen}
        onClose={closeLogin}
        title={loginStep === "email" ? "Вход в 220v" : loginStep === "password" ? "Введите пароль" : "Введите код"}
        subtitle={
          loginStep === "email"
            ? "Мы отправим код подтверждения на вашу почту"
            : loginStep === "password"
              ? `Пароль для ${normalizedEmail}`
              : (
                  <>
                    Код уже летит на <b className="login-sent-email">{normalizedEmail}</b>
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
            <p className="login-support-hint">
              Забыли пароль и нет доступа к почте? Если аккаунт уже есть, напишите в поддержку на{" "}
              <a href={SUPPORT_MAILTO} className="modal__link">
                {SUPPORT_EMAIL}
              </a>{" "}
              — после проверки вам установят пароль для входа.
            </p>
          </form>
        ) : (
          <div className="login-card" style={{ background: "transparent", border: 0, padding: 0, boxShadow: "none" }}>
            <EmailTypoHint
              email={normalizedEmail}
              onApply={applyEmailFixFromCodeStep}
              disabled={loading}
              className="login-typo-hint login-typo-hint--code"
            />
            {settingPassword ? (
              <div className="login-password-fields">
                <div className="password-field">
                  <input
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    aria-label="Новый пароль"
                    placeholder="6–128 символов, буквы и цифры"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    disabled={loading}
                  />
                  <PasswordVisibilityButton
                    visible={showPassword}
                    onClick={() => setShowPassword(!showPassword)}
                    disabled={loading}
                  />
                </div>
                <div className="password-field">
                  <input
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    aria-label="Повторите пароль"
                    placeholder="Повторите пароль"
                    value={repeatPassword}
                    onChange={(e) => setRepeatPassword(e.target.value)}
                    disabled={loading}
                  />
                  <PasswordVisibilityButton
                    visible={showPassword}
                    onClick={() => setShowPassword(!showPassword)}
                    disabled={loading}
                  />
                </div>
              </div>
            ) : null}
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
              <InputOTP
                maxLength={5}
                value={code}
                onChange={setCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
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
                {loading ? "Проверка..." : "Подтвердить"}
              </button>
            </div>
            {!hasPassword ? (
              <div className="login-password-optional">
                <p>Пароль задавать необязательно — с ним можно входить без кода из письма</p>
                <button
                  type="button"
                  className="btn btn--ghost btn--wide"
                  disabled={loading}
                  onClick={() => {
                    setSettingPassword(!settingPassword);
                    setNewPassword("");
                    setRepeatPassword("");
                  }}
                >
                  {settingPassword ? "Продолжить без пароля" : "Задать пароль"}
                </button>
              </div>
            ) : null}
            <p className="form-link">
              <button
                type="button"
                onClick={() => {
                  void handleSendCode();
                }}
                disabled={loading || resendCooldownSec > 0}
              >
                {resendCooldownSec > 0
                  ? formatResendCooldownButtonLabel(resendCooldownSec)
                  : "Отправить код повторно"}
              </button>
            </p>
            <p className="form-link">
              Ошиблись почтой?{" "}
              <button
                type="button"
                onClick={() => {
                  setCode("");
                  resetPasswordFields();
                  setLoginStep("email");
                }}
                disabled={loading}
              >
                Исправить
              </button>
            </p>
            <p className="login-support-hint">
              Не приходит код или нет доступа к почте? Если аккаунт уже есть, напишите в поддержку на{" "}
              <a href={SUPPORT_MAILTO} className="modal__link">
                {SUPPORT_EMAIL}
              </a>{" "}
              — после проверки вам установят пароль для входа.
            </p>
          </div>
        )}
      </LandingModal>
    </LandingShell>
  );
};

export default Index;
