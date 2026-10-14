import { useEffect, useState, useRef, useCallback, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Smartphone,
  CalendarClock,
  Trash,
  Loader2,
  HelpCircle,
  Gift,
  Tag,
  Info,
  LogOut,
  Send,
  Download,
  Link2,
  Copy,
  QrCode,
  CreditCard,
  ShoppingCart,
  Gauge,
  BookOpen,
  LifeBuoy,
  MoreHorizontal,
  CheckCircle2,
  AlertTriangle,
  KeyRound,
} from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { resetSupportChat } from "@/lib/supportChat";
import { useSession } from "@/hooks/useSession";
import { trafficPurchaseRestriction, useTrafficPurchaseRestriction } from "@/hooks/useTrafficPurchaseRestriction";
import {
  clearChatCompatCache,
  consumePendingPromoCode,
  getVpnSubscriptionUrl,
  normalizePromoCode,
  peekPendingPromoCode,
  persistChatCompatCache,
  setVpnSubscriptionUrl,
  setVpnTalkmeProfileJson,
} from "@/lib/vpnStorage";
import type { BillingPaymentMethod } from "@/lib/paymentMethods";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { oneClickHappUrl, isInstructionsPlatform, type InstructionsPlatform } from "@/lib/happ";
import LandingShell from "@/pages/landing/LandingShell";
import LandingFooter from "@/pages/landing/LandingFooter";
import DashboardSidebar, { type DashboardSidebarItem } from "@/components/DashboardSidebar";
import PasswordDialog from "@/components/PasswordDialog";
import { SIDEBAR_SHOW_OTHER, SIDEBAR_SHOW_REFERRALS } from "@/hooks/useDashboardSidebarItems";

interface UserData {
  plan: string;
  /** Код тарифа из RMW: trial | 1month | 6month | 12month */
  tariff?: string;
  status?: string;
  devicesLimit: number;
  currentDevices?: number;
  usedDays: number;
  expireAt: string;
  daysLeft: number;
  username: string;
  userUuid?: string;
  subscriptionUrl?: string;
  shortUuid?: string;
  usedTrafficBytes?: number;
  trafficLimitBytes?: number;
}

interface HwidDevice {
  hwid: string;
  userAgent?: string;
  platform?: string;
  deviceModel?: string;
  osVersion?: string;
  createdAt?: string;
  userUuid?: string;
}

type BillingMeta = {
  payments: BillingPaymentMethod[];
  products: {
    product_key: string;
    tariff_key: string;
    price: number | null;
    duration: string | null;
    traffic_limit_bytes: number | null;
    type: string | null;
  }[];
};

type ApplyPromoResponse = {
  ok?: boolean;
  promo_code?: string;
  days_added?: number;
  new_expire_at?: string;
};

type PromoResult = {
  status: "success" | "error";
  title: string;
  message: string;
};

function toSafeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toSafeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeUserData(value: unknown): UserData | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  const plan = toSafeString(raw.plan, "—");
  const username = toSafeString(raw.username, "—");
  if (!plan || !username) return null;

  return {
    plan,
    tariff: toSafeString(raw.tariff, ""),
    status: toSafeString(raw.status, ""),
    devicesLimit: toSafeNumber(raw.devicesLimit, 0),
    currentDevices: toSafeNumber(raw.currentDevices, 0),
    usedDays: toSafeNumber(raw.usedDays, 0),
    expireAt: toSafeString(raw.expireAt, ""),
    daysLeft: toSafeNumber(raw.daysLeft, 0),
    username,
    userUuid: toSafeString(raw.userUuid, ""),
    subscriptionUrl: toSafeString(raw.subscriptionUrl, ""),
    shortUuid: toSafeString(raw.shortUuid, ""),
    usedTrafficBytes: toSafeNumber(raw.usedTrafficBytes, 0),
    trafficLimitBytes: toSafeNumber(raw.trafficLimitBytes, 0),
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

/** Русская плюральная форма для «день/дня/дней». */
function pluralDays(n: number): string {
  const abs = Math.abs(Math.round(n)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return "дней";
  if (last === 1) return "день";
  if (last >= 2 && last <= 4) return "дня";
  return "дней";
}

type RingProps = {
  /** Заполненная доля кольца в диапазоне 0..100. */
  percent: number;
  size?: "lg" | "md";
  danger?: boolean;
  children?: ReactNode;
  ariaLabel?: string;
};

/** Круговой индикатор прогресса на SVG. Заполнение = accent/зелёное, danger = красный. */
const Ring = ({ percent, size = "lg", danger, children, ariaLabel }: RingProps) => {
  const RADIUS = 60;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const offset = CIRCUMFERENCE * (1 - clamped / 100);

  return (
    <div
      className={`dash-ring${size === "md" ? " dash-ring--md" : ""}${danger ? " dash-ring--danger" : ""}`}
      role="img"
      aria-label={ariaLabel}
    >
      <svg className="dash-ring__svg" viewBox="0 0 140 140" aria-hidden="true">
        <circle className="dash-ring__track" cx="70" cy="70" r={RADIUS} />
        <circle
          className="dash-ring__bar"
          cx="70"
          cy="70"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="dash-ring__content">{children}</div>
    </div>
  );
};

/** Сохраняется при уходе с /dashboard?… без сессии, чтобы после входа открыть тот же deep link */
const DASHBOARD_PENDING_SEARCH_KEY = "vpn_dashboard_pending_search";

const Dashboard = () => {
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [billingMeta, setBillingMeta] = useState<BillingMeta | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [devices, setDevices] = useState<HwidDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [deletingHwid, setDeletingHwid] = useState<string | null>(null);
  const [trafficInfoOpen, setTrafficInfoOpen] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState<number | null>(null);
  const [trafficBuyOpen, setTrafficBuyOpen] = useState(false);
  const [trafficPaymentStep, setTrafficPaymentStep] = useState<{ gb: number; price: number } | null>(null);
  const [otherMenuOpen, setOtherMenuOpen] = useState(false);
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoApplying, setPromoApplying] = useState(false);
  const [promoResult, setPromoResult] = useState<PromoResult | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [subscriptionQrOpen, setSubscriptionQrOpen] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const copySubscriptionButtonRef = useRef<HTMLButtonElement>(null);
  const autoPromoAttemptRef = useRef("");

  const navigate = useNavigate();
  const location = useLocation();

  const openInstructions = useCallback(
    (platform?: InstructionsPlatform) => {
      const search = platform ? `?platform=${platform}` : "";
      navigate(`/instructions${search}`);
    },
    [navigate],
  );

  // Обратная совместимость: state.openInstructions от страниц вроде /pay/success
  // теперь редиректит на отдельную страницу /instructions.
  useEffect(() => {
    const st = location.state as { openInstructions?: boolean } | null;
    if (!st?.openInstructions) return;
    navigate("/instructions", { replace: true });
  }, [location.state, navigate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await apiGet<BillingMeta>("/billing/meta");
      if (cancelled) return;
      if (error) {
        // не блокируем весь дашборд, просто оставим fallback значения ниже
        console.warn("billing/meta failed:", error);
        return;
      }
      if (data && typeof data === "object" && Array.isArray((data as BillingMeta).payments)) {
        setBillingMeta(data);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const { status: sessionStatus, email: sessionEmail } = useSession();

  const email = sessionEmail;

  useEffect(() => {
    if (sessionStatus === "checking") return;

    if (sessionStatus === "guest") {
      if (location.search) {
        try {
          sessionStorage.setItem(DASHBOARD_PENDING_SEARCH_KEY, location.search);
        } catch {
          // ignore
        }
      }
      navigate("/", { replace: true });
      return;
    }

    const sp = new URLSearchParams(location.search);
    if (sp.get("support") === "1") {
      navigate("/chat", { replace: true });
      return;
    }

    if (!email) return;

    const fetchUser = async () => {
      try {
        const { data, error: fnError } = await apiGet<{ user?: unknown; error?: string; exists?: boolean; hasPassword?: boolean }>("/me");

        if (fnError) throw fnError;
        if (data?.user) {
          setHasPassword(Boolean(data.hasPassword));
          const normalizedUser = normalizeUserData(data.user);
          if (!normalizedUser) {
            setError("Некорректный формат данных пользователя");
            return;
          }
          if (normalizedUser.subscriptionUrl) {
            setVpnSubscriptionUrl(normalizedUser.subscriptionUrl);
          }
          const talkmeJson = JSON.stringify({
            usedTrafficBytes: normalizedUser.usedTrafficBytes,
            trafficLimitBytes: normalizedUser.trafficLimitBytes,
            expireAt: normalizedUser.expireAt,
            currentDevices: normalizedUser.currentDevices,
            devicesLimit: normalizedUser.devicesLimit,
            tariff: normalizedUser.tariff,
            plan: normalizedUser.plan,
          });
          setVpnTalkmeProfileJson(talkmeJson);
          persistChatCompatCache({
            email,
            subscriptionUrl: normalizedUser.subscriptionUrl,
            talkmeProfileJson: talkmeJson,
          });
          setUserData(normalizedUser);
        } else {
          setError(data?.error || "Не удалось получить данные");
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Ошибка загрузки данных");
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, [navigate, email, location.search, location.pathname, sessionStatus]);

  const clearDashboardSearch = useCallback(() => {
    if (!location.search) return;
    navigate({ pathname: location.pathname, search: "" }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const fetchDevices = useCallback(async () => {
    if (!userData?.userUuid) return;
    setDevicesLoading(true);
    try {
      const { data, error } = await apiGet<{ devices?: HwidDevice[]; total?: number }>("/me/devices");
      if (!error && data?.devices) {
        setDevices(data.devices);
        const devicesCount = Array.isArray(data.devices) ? data.devices.length : 0;
        setUserData((prev) => {
          if (!prev) return prev;
          const next = { ...prev, currentDevices: toSafeNumber(data.total, devicesCount) };
          setVpnTalkmeProfileJson(
            JSON.stringify({
              usedTrafficBytes: next.usedTrafficBytes,
              trafficLimitBytes: next.trafficLimitBytes,
              expireAt: next.expireAt,
              currentDevices: next.currentDevices,
              devicesLimit: next.devicesLimit,
              tariff: next.tariff,
              plan: next.plan,
            }),
          );
          return next;
        });
      }
    } catch (_e) {
      // ignore
    } finally {
      setDevicesLoading(false);
    }
  }, [userData?.userUuid]);

  const refreshUserData = useCallback(async () => {
    if (!email) return;
    const { data, error: fnError } = await apiGet<{ user?: unknown; error?: string; exists?: boolean; hasPassword?: boolean }>("/me");
    if (fnError) throw fnError;
    if (!data?.user) {
      throw new Error(data?.error || "Не удалось получить данные");
    }
    setHasPassword(Boolean(data.hasPassword));
    const normalizedUser = normalizeUserData(data.user);
    if (!normalizedUser) {
      throw new Error("Некорректный формат данных пользователя");
    }
    if (normalizedUser.subscriptionUrl) {
      setVpnSubscriptionUrl(normalizedUser.subscriptionUrl);
    }
    const talkmeJson = JSON.stringify({
      usedTrafficBytes: normalizedUser.usedTrafficBytes,
      trafficLimitBytes: normalizedUser.trafficLimitBytes,
      expireAt: normalizedUser.expireAt,
      currentDevices: normalizedUser.currentDevices,
      devicesLimit: normalizedUser.devicesLimit,
      tariff: normalizedUser.tariff,
      plan: normalizedUser.plan,
    });
    setVpnTalkmeProfileJson(talkmeJson);
    persistChatCompatCache({
      email,
      subscriptionUrl: normalizedUser.subscriptionUrl,
      talkmeProfileJson: talkmeJson,
    });
    setUserData(normalizedUser);
  }, [email]);

  const applyPromoCode = useCallback(
    async (rawCode: string) => {
      const code = normalizePromoCode(rawCode);
      if (!code) {
        setPromoResult({
          status: "error",
          title: "Промокод не активирован",
          message: "Проверьте промокод и попробуйте ещё раз.",
        });
        return;
      }

      setPromoApplying(true);
      try {
        const { data, error: fnError } = await apiPost<ApplyPromoResponse>("/me/promo-code/apply", {
          promo_code: code,
        });
        if (fnError) throw fnError;
        const daysAdded = Number(data?.days_added ?? 0);
        setPromoCode("");
        setPromoOpen(false);
        setPromoResult({
          status: "success",
          title: "Промокод активирован",
          message:
            daysAdded > 0
              ? `Промокод ${code} активирован. Добавлено ${daysAdded} ${pluralDays(daysAdded)}.`
              : `Промокод ${code} активирован.`,
        });
        try {
          await refreshUserData();
        } catch (err) {
          console.warn("refresh user after promo failed:", err);
        }
      } catch (err: unknown) {
        setPromoResult({
          status: "error",
          title: "Промокод не активирован",
          message: err instanceof Error ? err.message : "Не удалось активировать промокод",
        });
      } finally {
        setPromoApplying(false);
      }
    },
    [refreshUserData],
  );

  useEffect(() => {
    if (loading || error || !userData) return;
    const sp = new URLSearchParams(location.search);
    if (!sp.toString() && !peekPendingPromoCode()) return;

    const stripAnd = (fn: () => void) => {
      fn();
      clearDashboardSearch();
    };

    if (sp.get("devices") === "1") {
      stripAnd(() => {
        setDevicesOpen(true);
        void fetchDevices();
      });
      return;
    }
    if (sp.get("subscription") === "1") {
      stripAnd(() => navigate("/dashboard", { replace: true }));
      return;
    }
    const buy = (sp.get("buy") ?? "").toLowerCase();
    if (buy === "tariff") {
      stripAnd(() => navigate("/tariff"));
      return;
    }
    if (buy === "traffic") {
      stripAnd(() => {
        setTrafficBuyOpen(true);
        setTrafficPaymentStep(null);
      });
      return;
    }
    if (sp.has("instructions")) {
      const raw = (sp.get("instructions") ?? "auto").toLowerCase();
      const search = isInstructionsPlatform(raw) ? `?platform=${raw}` : "";
      // Чистим search на /dashboard и уходим на отдельную страницу инструкций.
      clearDashboardSearch();
      navigate(`/instructions${search}`, { replace: true });
      return;
    }
    if (sp.get("referral") === "1") {
      stripAnd(() => navigate("/referrals", { replace: true }));
      return;
    }
    if (sp.get("promo") === "1") {
      stripAnd(() => setPromoOpen(true));
      return;
    }
    const promoParam = sp.get("promo");
    const promoCodeFromUrl = promoParam ? normalizePromoCode(promoParam) : "";
    const promoCodeToApply = promoParam ? promoCodeFromUrl : peekPendingPromoCode();
    if (promoParam || promoCodeToApply) {
      stripAnd(() => {
        if (!promoCodeToApply) {
          setPromoResult({
            status: "error",
            title: "Промокод не активирован",
            message: "Проверьте промокод и попробуйте ещё раз.",
          });
          return;
        }
        if (autoPromoAttemptRef.current === promoCodeToApply) return;
        autoPromoAttemptRef.current = promoCodeToApply;
        consumePendingPromoCode();
        void applyPromoCode(promoCodeToApply);
      });
      return;
    }
    if (sp.get("about") === "1") {
      stripAnd(() => setAboutOpen(true));
      return;
    }
  }, [loading, error, userData, location.search, clearDashboardSearch, fetchDevices, navigate, applyPromoCode]);

  const handleOpenDevices = () => {
    const count = userData?.currentDevices ?? 0;
    if (count === 0) {
      openInstructions();
      return;
    }
    setDevicesOpen(true);
    fetchDevices();
  };

  const handleDeleteDevice = async (hwid: string) => {
    if (!userData?.userUuid) return;
    setDeletingHwid(hwid);
    try {
      const { data, error } = await apiDelete<{ success?: boolean }>(
        `/me/devices/${encodeURIComponent(hwid)}`,
      );
      if (!error && data?.success) {
        setDevices((prev) => prev.filter((d) => d.hwid !== hwid));
        setUserData((prev) =>
          prev ? { ...prev, currentDevices: Math.max(0, (prev.currentDevices ?? 0) - 1) } : prev,
        );
      }
    } catch (_e) {
      // ignore
    } finally {
      setDeletingHwid(null);
    }
  };

  const paymentMethods =
    billingMeta?.payments?.length
      ? billingMeta.payments
      : [
          { id: 2, type: "sbp", label: "СБП (QR-код)" },
          { id: 11, type: "card", label: "Оплата картой" },
          { id: 13, type: "crypto", label: "Криптовалюта" },
        ];

  const productPriceByKey = new Map(
    (billingMeta?.products ?? [])
      .filter((p) => p && typeof p.product_key === "string")
      .map((p) => [p.product_key, typeof p.price === "number" ? p.price : null]),
  );

  const trafficProductKey: Record<number, string> = {
    20: "traffic_20gb",
    50: "traffic_50gb",
  };

  const handleTrafficPayment = async (paymentMethod: number) => {
    if (!trafficPaymentStep) return;
    const restriction = trafficPurchaseRestriction(userData);
    if (restriction) {
      toast.error(restriction);
      return;
    }
    if (!userData?.userUuid) {
      toast.error("Не найден профиль пользователя. Обновите страницу.");
      return;
    }
    const product_key = trafficProductKey[trafficPaymentStep.gb];
    const allowedPayments = new Set(paymentMethods.map((m) => m.id));
    if (!allowedPayments.has(paymentMethod) || !product_key) {
      toast.error("Некорректные параметры оплаты");
      return;
    }
    setPaymentLoading(paymentMethod);
    try {
      const { data, error: fnError } = await apiPost<{ payment_url?: string }>("/checkout", {
        product_key,
        payment_method: paymentMethod,
      });
      if (fnError) throw fnError;
      const paymentUrl =
        data && typeof data === "object" && "payment_url" in data && typeof (data as { payment_url: unknown }).payment_url === "string"
          ? (data as { payment_url: string }).payment_url
          : "";
      if (paymentUrl) {
        window.location.href = paymentUrl;
      } else {
        toast.error("Не удалось получить ссылку на оплату");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Ошибка при создании платежа");
    } finally {
      setPaymentLoading(null);
    }
  };

  const handleTrafficPaymentMethodClick = (method: BillingPaymentMethod) => {
    void handleTrafficPayment(method.id);
  };

  const handleLogout = async () => {
    await apiPost("/auth/logout");
    clearChatCompatCache();
    resetSupportChat();
    navigate("/");
  };

  /** Тот же URL, что в инструкциях у «Скопировать ссылку подписки» (данные пользователя или localStorage). */
  const resolveSubscriptionUrl = () => {
    const fromUser = (userData?.subscriptionUrl ?? "").trim();
    if (fromUser) return fromUser;
    return getVpnSubscriptionUrl();
  };

  /**
   * Копирование в буфер из пользовательского жеста (без async-обёртки — иначе Clipboard API блокируется).
   * Фолбэк: временный input на кнопке + execCommand (как на странице /instructions).
   */
  const handleCopySubscriptionLink = () => {
    const url = resolveSubscriptionUrl();
    if (!url) {
      toast.error("Ссылка подписки недоступна");
      return;
    }

    const copyViaExecCommand = () => {
      const container = copySubscriptionButtonRef.current;
      if (!container) {
        toast.error("Не удалось скопировать");
        return;
      }
      const input = document.createElement("input");
      input.type = "text";
      input.value = url;
      input.style.position = "absolute";
      input.style.opacity = "0";
      input.style.height = "0";
      input.style.fontSize = "16px";
      container.appendChild(input);
      input.focus();
      input.setSelectionRange(0, input.value.length);
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      container.removeChild(input);
      if (ok) {
        toast.success("Ссылка скопирована!", {
          style: { background: "#0a0a0a", color: "#fff", border: "1px solid #22c55e" },
        });
      } else {
        toast.error("Не удалось скопировать. Скопируйте вручную:", {
          description: url,
          duration: 8000,
        });
      }
    };

    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => {
          toast.success("Ссылка скопирована!", {
            style: { background: "#0a0a0a", color: "#fff", border: "1px solid #22c55e" },
          });
        },
        () => {
          copyViaExecCommand();
        },
      );
      return;
    }
    copyViaExecCommand();
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  };

  const trafficLimitBytes = userData?.trafficLimitBytes ?? 0;
  const trafficRestriction = useTrafficPurchaseRestriction(userData);
  const usedTrafficBytes = userData?.usedTrafficBytes ?? 0;
  const hasTrafficLimit = trafficLimitBytes > 0;
  const trafficPercent = hasTrafficLimit
    ? Math.min(100, Math.round((usedTrafficBytes / trafficLimitBytes) * 100))
    : 0;
  const remainingBytes = Math.max(0, trafficLimitBytes - usedTrafficBytes);
  const tariffLc = (userData?.tariff ?? "").toLowerCase();
  const planLc = (userData?.plan ?? "").toLowerCase();
  const paidTariffCodes = new Set(["1month", "6month", "12month"]);
  const paidPlanLabels = ["1 месяц", "6 месяцев", "12 месяцев"];
  const isPremiumPlan =
    paidTariffCodes.has(tariffLc) ||
    planLc === "premium" ||
    paidPlanLabels.includes(planLc);
  const isExpired = (userData?.status ?? "").toUpperCase() === "EXPIRED";
  const isTrafficExhausted = hasTrafficLimit && usedTrafficBytes >= trafficLimitBytes;
  const daysLeft = Math.max(0, userData?.daysLeft ?? 0);
  const usedDays = Math.max(0, userData?.usedDays ?? 0);
  const totalDays = usedDays + daysLeft;
  // Доля оставшихся дней (для кольца в hero). 100% = подписка только куплена; 0% = истекла.
  const daysRemainingPercent = isExpired
    ? 0
    : totalDays > 0
      ? Math.max(0, Math.min(100, Math.round((daysLeft / totalDays) * 100)))
      : 0;
  const currentDevices = userData?.currentDevices ?? 0;
  const devicesLimit = userData?.devicesLimit ?? 0;

  const sidebarItems: DashboardSidebarItem[] = [
    {
      key: "subscription",
      label: "Моя подписка",
      icon: CreditCard,
      onClick: () => navigate("/dashboard"),
      primary: true,
      match: "/dashboard",
    },
    {
      key: "tariff",
      label: "Купить тариф",
      icon: ShoppingCart,
      onClick: () => navigate("/tariff"),
      match: "/tariff",
    },
    ...(isPremiumPlan && !trafficRestriction
      ? ([
          {
            key: "traffic",
            label: "Купить трафик",
            icon: Gauge,
            onClick: () => navigate("/traffic"),
            match: "/traffic",
          },
        ] as DashboardSidebarItem[])
      : []),
    {
      key: "instructions",
      label: "Инструкции",
      icon: BookOpen,
      onClick: () => openInstructions(),
      match: "/instructions",
    },
    {
      key: "support",
      label: "Поддержка",
      icon: LifeBuoy,
      onClick: () => navigate("/chat"),
      match: ["/support", "/chat"],
    },
    ...(SIDEBAR_SHOW_REFERRALS
      ? ([
          {
            key: "referrals",
            label: "Реферальная программа",
            icon: Gift,
            onClick: () => navigate("/referrals"),
            match: "/referrals",
          },
        ] as DashboardSidebarItem[])
      : []),
    ...(SIDEBAR_SHOW_OTHER
      ? ([
          {
            key: "other",
            label: "Другое",
            icon: MoreHorizontal,
            onClick: () => setOtherMenuOpen(true),
          },
        ] as DashboardSidebarItem[])
      : []),
  ];

  if (loading) {
    return (
      <LandingShell className="landing-root--with-sidebar landing-root--dashboard">
        <DashboardSidebar items={[]} onLogout={handleLogout} mobileTitle="Личный кабинет" />
        <main className="app-page">
          <div className="container">
            <div className="app-page__notice app-page__notice--loader">
              <div
                className="bolt-loader"
                role="status"
                aria-label="Загружаем ваш личный кабинет"
              >
                <svg
                  viewBox="-16 -18 96 132"
                  className="bolt-loader__svg"
                  aria-hidden="true"
                  preserveAspectRatio="xMidYMid meet"
                >
                  <defs>
                    <clipPath id="bolt-loader-clip">
                      <path d="M47 -6 L8 54 h18 l-6 42 L60 34 H42 Z" />
                    </clipPath>
                  </defs>
                  <path
                    d="M47 -6 L8 54 h18 l-6 42 L60 34 H42 Z"
                    className="bolt-loader__outline"
                  />
                  <g clipPath="url(#bolt-loader-clip)">
                    <rect
                      x="0"
                      y="0"
                      width="64"
                      height="96"
                      className="bolt-loader__fill"
                    />
                  </g>
                </svg>
              </div>
            </div>
          </div>
        </main>
        <LandingFooter />
      </LandingShell>
    );
  }

  if (error) {
    return (
      <LandingShell className="landing-root--with-sidebar landing-root--dashboard">
        <DashboardSidebar items={[]} onLogout={handleLogout} mobileTitle="Личный кабинет" />
        <main className="app-page">
          <div className="container">
            <div className="app-page__notice">
              <p>{error}</p>
              <button type="button" className="btn btn--primary" onClick={handleLogout}>
                Назад
              </button>
            </div>
          </div>
        </main>
        <LandingFooter />
      </LandingShell>
    );
  }

  return (
    <LandingShell className="landing-root--with-sidebar landing-root--dashboard">
      <DashboardSidebar
        items={sidebarItems}
        onLogout={handleLogout}
        email={email || undefined}
        mobileTitle="Личный кабинет"
      />

      <main>
        <section className="app-page">
          <div className="container">
            <header className="dash-topbar">
              <div className="dash-topbar__lead">
                <div className="dash-topbar__kicker">Личный кабинет 220v</div>
                <h1 className="dash-topbar__title">С возвращением</h1>
                {email ? <div className="dash-topbar__email">{email}</div> : null}
                <button
                  type="button"
                  className="dash-topbar__password"
                  onClick={() => setPasswordDialogOpen(true)}
                >
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                  {hasPassword ? "Сменить пароль" : "Задать пароль"}
                </button>
              </div>
              <span
                className={`dash-badge ${isExpired ? "dash-badge--danger" : "dash-badge--ok"}`}
              >
                {isExpired ? "Подписка истекла" : "Подписка активна"}
              </span>
            </header>

            <section className={`dash-hero ${isExpired ? "dash-hero--danger" : ""}`}>
              <div className="dash-hero__info">
                <span className="dash-hero__label">Ваш тариф</span>
                <span className="dash-hero__plan">{isExpired ? "Истёк" : userData?.plan || "—"}</span>
                <span className="dash-hero__date">
                  <CalendarClock className="h-4 w-4" aria-hidden="true" />
                  {userData?.expireAt
                    ? `${isExpired ? "Завершился" : "Действует до"} ${formatDate(userData.expireAt)}`
                    : "Дата окончания неизвестна"}
                </span>
              </div>

              <Ring
                percent={daysRemainingPercent}
                danger={isExpired}
                ariaLabel={`Осталось ${daysLeft} ${pluralDays(daysLeft)}`}
              >
                <span className="dash-ring__value">{daysLeft}</span>
                <span className="dash-ring__label">{pluralDays(daysLeft)}</span>
              </Ring>

              <div className="dash-hero__action">
                <button
                  type="button"
                  className="dash-hero__cta"
                  onClick={() => navigate("/tariff")}
                >
                  <ShoppingCart className="h-5 w-5" aria-hidden="true" />
                  Продлить подписку
                </button>
                <span className="dash-hero__hint">
                  {isExpired
                    ? "Выберите тариф, чтобы вернуть доступ"
                    : "На 6 и 12 месяцев действуют скидки"}
                </span>
              </div>
            </section>

            <div className="dash-grid">
              <section className="dash-card">
                <header className="dash-card__head">
                  <div className="dash-card__icon" aria-hidden="true">
                    <Link2 className="h-5 w-5" />
                  </div>
                  <div className="dash-card__head-text">
                    <div className="dash-card__title">Подключение</div>
                    <div className="dash-card__desc">
                      Добавьте подписку в приложение Happ
                    </div>
                  </div>
                </header>

                <div className="dash-card__body">
                  <button
                    type="button"
                    className="dash-card__primary"
                    disabled={!resolveSubscriptionUrl()}
                    onClick={() => {
                      const url = resolveSubscriptionUrl();
                      if (!url) {
                        toast.error("Ссылка подписки недоступна");
                        return;
                      }
                      window.location.href = oneClickHappUrl(url);
                    }}
                  >
                    <Link2 className="h-5 w-5" aria-hidden="true" />
                    Добавить в Happ
                  </button>

                  <div className="dash-actions">
                    <button
                      type="button"
                      className="dash-actions__btn"
                      disabled={!resolveSubscriptionUrl()}
                      onClick={() => {
                        if (!resolveSubscriptionUrl()) {
                          toast.error("Ссылка подписки недоступна");
                          return;
                        }
                        setSubscriptionQrOpen(true);
                      }}
                    >
                      <QrCode className="h-5 w-5" aria-hidden="true" />
                      <span>QR-код</span>
                    </button>
                    <button
                      ref={copySubscriptionButtonRef}
                      type="button"
                      className="dash-actions__btn"
                      disabled={!resolveSubscriptionUrl()}
                      onClick={handleCopySubscriptionLink}
                    >
                      <Copy className="h-5 w-5" aria-hidden="true" />
                      <span>Копировать</span>
                    </button>
                    <button
                      type="button"
                      className="dash-actions__btn"
                      onClick={() => openInstructions()}
                    >
                      <Download className="h-5 w-5" aria-hidden="true" />
                      <span>Скачать</span>
                    </button>
                  </div>
                </div>
              </section>

              <section className="dash-card">
                <header className="dash-card__head">
                  <div className="dash-card__icon" aria-hidden="true">
                    <Smartphone className="h-5 w-5" />
                  </div>
                  <div className="dash-card__head-text">
                    <div className="dash-card__title">Устройства</div>
                    <div className="dash-card__desc">Подключено к аккаунту</div>
                  </div>
                </header>

                <div className="dash-card__body dash-card__body--center">
                  <div className="dash-metric">
                    <span className="dash-metric__value">{currentDevices}</span>
                    <span className="dash-metric__limit">/ {devicesLimit}</span>
                  </div>
                  {devicesLimit > 0 ? (
                    <div className="dash-dots" aria-hidden="true">
                      {Array.from({ length: devicesLimit }).map((_, i) => (
                        <span
                          key={i}
                          className={`dash-dot ${i < currentDevices ? "dash-dot--on" : ""}`}
                        />
                      ))}
                    </div>
                  ) : null}
                  <p className="dash-card__hint">
                    {currentDevices > 0
                      ? "Управляйте списком устройств вашего аккаунта"
                      : "Добавьте первое устройство через инструкции"}
                  </p>
                </div>

                <div className="dash-card__footer">
                  <button
                    type="button"
                    className="dash-card__footer-btn"
                    onClick={handleOpenDevices}
                  >
                    <Smartphone className="h-4 w-4" aria-hidden="true" />
                    {currentDevices > 0 ? "Управлять устройствами" : "Подключить устройство"}
                  </button>
                </div>
              </section>

              <section className={`dash-card ${isTrafficExhausted ? "dash-card--danger" : ""}`}>
                <header className="dash-card__head">
                  <div className="dash-card__icon" aria-hidden="true">
                    <Gauge className="h-5 w-5" />
                  </div>
                  <div className="dash-card__head-text">
                    <div className="dash-card__title">Трафик</div>
                    <div className="dash-card__desc">
                      {hasTrafficLimit ? "Остаток на LTE-серверах" : "Безлимит на всех серверах"}
                    </div>
                  </div>
                </header>

                <div className="dash-card__body dash-card__body--center">
                  {hasTrafficLimit ? (
                    <>
                      <Ring
                        percent={trafficPercent}
                        size="md"
                        danger={isTrafficExhausted}
                        ariaLabel={`Использовано ${trafficPercent}% трафика`}
                      >
                        <span className="dash-ring__value">{trafficPercent}%</span>
                        <span className="dash-ring__label">использовано</span>
                      </Ring>
                      <p className="dash-card__hint">
                        Осталось <strong>{formatBytes(remainingBytes)}</strong> из{" "}
                        <strong>{formatBytes(trafficLimitBytes)}</strong>
                      </p>
                    </>
                  ) : (
                    <div className="dash-unlim">
                      <Gauge className="h-5 w-5" aria-hidden="true" />
                      Без ограничений
                    </div>
                  )}
                </div>

                <div className="dash-card__footer dash-card__footer--split">
                  <button
                    type="button"
                    className="dash-card__footer-link"
                    onClick={() => setTrafficInfoOpen(true)}
                  >
                    <HelpCircle className="h-4 w-4" aria-hidden="true" />
                    Подробнее
                  </button>
                  {isPremiumPlan && !trafficRestriction ? (
                    <button
                      type="button"
                      className="dash-card__footer-btn"
                      onClick={() => navigate("/traffic")}
                    >
                      <Gauge className="h-4 w-4" aria-hidden="true" />
                      Докупить
                    </button>
                  ) : null}
                </div>
              </section>
            </div>
          </div>
        </section>
      </main>

      <LandingFooter />

      {/* Devices Modal */}
      <Dialog open={devicesOpen} onOpenChange={setDevicesOpen}>
        <DialogContent className="dash-modal max-h-[80dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Подключённые устройства</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>Здесь показаны устройства по HWID, привязанные к вашей учётной записи.</p>
                <p className="dash-modal__desc-accent">
                  Важно: убрав устройство из списка, вы не отключаете его от аккаунта — только освобождаете слот под другое
                  устройство. Чтобы ограничить доступ с посторонних устройств, обновите ссылку подключения в меню «Другое».
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>

          {devicesLoading ? (
            <div className="dash-modal__loader">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : devices.length === 0 ? (
            <p className="dash-modal__empty">Нет подключённых устройств</p>
          ) : (
            <div className="dash-modal__stack">
              {devices.map((device) => (
                <div key={device.hwid} className="dash-modal__item">
                  <div className="dash-modal__item-meta">
                    <p className="dash-modal__item-title">HWID: {device.hwid || "—"}</p>
                    {device.platform && (
                      <p className="dash-modal__item-sub">
                        {device.platform} {device.osVersion} — {device.deviceModel}
                      </p>
                    )}
                    {device.userAgent && (
                      <p className="dash-modal__item-sub truncate">{device.userAgent}</p>
                    )}
                    {device.createdAt && (
                      <p className="dash-modal__item-sub">{formatDate(device.createdAt)}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="dash-modal__item-remove"
                    disabled={deletingHwid === device.hwid}
                    onClick={() => handleDeleteDevice(device.hwid)}
                    aria-label="Удалить устройство"
                  >
                    {deletingHwid === device.hwid ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash className="h-4 w-4" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={subscriptionQrOpen} onOpenChange={setSubscriptionQrOpen}>
        <DialogContent className="dash-modal sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>QR-Code подписки</DialogTitle>
            <DialogDescription>
              Откройте приложение Happ, нажмите кнопку QR-Code в правом нижнем углу и отсканируйте данный код.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const qrUrl = resolveSubscriptionUrl();
            if (!qrUrl) {
              return <p className="dash-modal__empty">Ссылка подписки недоступна</p>;
            }
            return (
              <div className="dash-modal__stack items-center">
                <div className="dash-modal__qr">
                  <img
                    alt="QR-Code"
                    className="h-52 w-52"
                    width={220}
                    height={220}
                    loading="lazy"
                    decoding="async"
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrUrl)}`}
                  />
                </div>
                <button
                  type="button"
                  className="dash-modal-btn dash-modal-btn--ghost"
                  onClick={() => setSubscriptionQrOpen(false)}
                >
                  Закрыть
                </button>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Traffic Info Modal */}
      <Dialog open={trafficInfoOpen} onOpenChange={setTrafficInfoOpen}>
        <DialogContent className="dash-modal sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Учёт трафика</DialogTitle>
            <DialogDescription>
              Платно по трафику — только на LTE-серверах; на остальных площадках он не ограничен.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      {/* Buy Traffic Modal */}
      <Dialog
        open={trafficBuyOpen}
        onOpenChange={(open) => {
          setTrafficBuyOpen(open);
          if (!open) setTrafficPaymentStep(null);
        }}
      >
        <DialogContent className="dash-modal sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{trafficPaymentStep ? "Выберите способ оплаты" : "Купить трафик"}</DialogTitle>
            <DialogDescription>
              {trafficPaymentStep
                ? `${trafficPaymentStep.gb} ГБ — ${trafficPaymentStep.price} ₽`
                : "Выберите пакет трафика"}
            </DialogDescription>
          </DialogHeader>
          <div className="dash-modal__stack">
            {trafficRestriction ? (
              <>
                <p role="status">{trafficRestriction}</p>
                <button type="button" className="dash-modal-btn dash-modal-btn--ghost" onClick={() => navigate("/tariff")}>
                  К тарифам
                </button>
              </>
            ) : !trafficPaymentStep ? (
              [
                { gb: 20, price: productPriceByKey.get("traffic_20gb") ?? null },
                { gb: 50, price: productPriceByKey.get("traffic_50gb") ?? null },
              ].map((opt) => (
                <button
                  key={opt.gb}
                  type="button"
                  className="dash-modal-btn dash-modal-btn--ghost dash-modal-btn--split"
                  onClick={() => {
                    if (typeof opt.price !== "number") {
                      toast.error("Не удалось загрузить цену пакета");
                      return;
                    }
                    setTrafficPaymentStep({ gb: opt.gb, price: opt.price });
                  }}
                >
                  <span>{opt.gb} ГБ</span>
                  <span className="dash-modal-btn__price">{opt.price ?? "—"} ₽</span>
                </button>
              ))
            ) : (
              <>
                <button
                  type="button"
                  className="dash-modal-btn dash-modal-btn--back"
                  onClick={() => setTrafficPaymentStep(null)}
                >
                  ← Назад
                </button>
                {paymentMethods.map((method) => (
                  <button
                    key={method.id}
                    type="button"
                    className="dash-modal-btn dash-modal-btn--ghost"
                    disabled={paymentLoading !== null}
                    onClick={() => handleTrafficPaymentMethodClick(method)}
                  >
                    {paymentLoading === method.id ? <Loader2 className="h-5 w-5 animate-spin" /> : method.label}
                  </button>
                ))}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {/* Other Menu Modal */}
      <Dialog open={otherMenuOpen} onOpenChange={setOtherMenuOpen}>
        <DialogContent className="dash-modal sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Другое</DialogTitle>
            <DialogDescription>Выберите действие</DialogDescription>
          </DialogHeader>
          <div className="dash-modal__stack">
            <button
              type="button"
              className="dash-modal-btn dash-modal-btn--ghost dash-modal-btn--menu"
              onClick={() => {
                setOtherMenuOpen(false);
                setPromoOpen(true);
              }}
            >
              <Tag className="h-5 w-5" />
              Промокод
            </button>
            <button
              type="button"
              className="dash-modal-btn dash-modal-btn--ghost dash-modal-btn--menu"
              onClick={() => {
                setOtherMenuOpen(false);
                setAboutOpen(true);
              }}
            >
              <Info className="h-5 w-5" />
              О нас
            </button>
            <button
              type="button"
              className="dash-modal-btn dash-modal-btn--ghost dash-modal-btn--menu"
              onClick={() => {
                setOtherMenuOpen(false);
                setPasswordDialogOpen(true);
              }}
            >
              <KeyRound className="h-5 w-5" />
              {hasPassword ? "Сменить пароль" : "Задать пароль"}
            </button>
            <button
              type="button"
              className="dash-modal-btn dash-modal-btn--ghost dash-modal-btn--menu"
              onClick={() => {
                setOtherMenuOpen(false);
                window.open("https://t.me/vpn220v_bot", "_blank", "noopener,noreferrer");
              }}
            >
              <Send className="h-5 w-5" />
              Telegram-бот
            </button>
            <button
              type="button"
              className="dash-modal-btn dash-modal-btn--danger dash-modal-btn--menu"
              onClick={handleLogout}
            >
              <LogOut className="h-5 w-5" />
              Выход
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <PasswordDialog
        open={passwordDialogOpen}
        onOpenChange={setPasswordDialogOpen}
        hasPassword={hasPassword}
        onChanged={() => setHasPassword(true)}
      />

      {/* Promo Code Modal */}
      <Dialog open={promoOpen} onOpenChange={setPromoOpen}>
        <DialogContent className="dash-modal sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Промокод</DialogTitle>
            <DialogDescription>Введите промокод чтобы активировать бонусы</DialogDescription>
          </DialogHeader>
          <div className="dash-modal__stack">
            <input
              type="text"
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value)}
              placeholder="Введите промокод"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="done"
              className="dash-modal__input"
            />
            <button
              type="button"
              className="dash-modal-btn dash-modal-btn--primary"
              disabled={promoApplying}
              onClick={() => void applyPromoCode(promoCode)}
            >
              {promoApplying ? "Активируем..." : "Активировать"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(promoResult)} onOpenChange={(open) => !open && setPromoResult(null)}>
        <DialogContent className="dash-modal sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{promoResult?.title ?? "Промокод"}</DialogTitle>
            <DialogDescription className="sr-only">{promoResult?.message ?? ""}</DialogDescription>
          </DialogHeader>
          <div
            className={
              promoResult?.status === "success"
                ? "dash-modal__result dash-modal__result--success"
                : "dash-modal__result dash-modal__result--error"
            }
          >
            <div className="dash-modal__result-icon" aria-hidden="true">
              {promoResult?.status === "success" ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : (
                <AlertTriangle className="h-5 w-5" />
              )}
            </div>
            <p className="dash-modal__result-text">{promoResult?.message ?? ""}</p>
          </div>
          <div className="dash-modal__stack dash-modal__actions">
            <button
              type="button"
              className="dash-modal-btn dash-modal-btn--primary"
              onClick={() => setPromoResult(null)}
            >
              Понятно
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* About Us Modal */}
      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="dash-modal max-h-[85dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>О нас</DialogTitle>
            <DialogDescription className="sr-only">
              220v — быстрый и безопасный VPN. Условия, скорость, безопасность сервиса.
            </DialogDescription>
          </DialogHeader>
          <div>
            <p className="dash-modal__lead">220v — быстрый и безопасный VPN</p>

            <div className="dash-modal__section">
              <p className="dash-modal__section-title">📋 Условия и возможности</p>
              <ul className="dash-modal__list">
                <li>
                  <strong>Трафик:</strong> 100 ГБ на серверах для мобильного интернета и полный безлимит на всех
                  остальных локациях.
                </li>
                <li>
                  <strong>Гибкость:</strong> Пользуйтесь одним аккаунтом одновременно на 7 устройствах.
                </li>
                <li>
                  <strong>Выгода:</strong> На тарифах 6 и 12 месяцев купленный дополнительный трафик для мобильных
                  серверов не сгорает и переносится на следующий месяц.
                </li>
                <li>
                  <strong>Доступность:</strong> Прозрачные тарифы, бесплатный тест-драйв и старт в один клик.
                </li>
              </ul>
            </div>

            <div className="dash-modal__section">
              <p className="dash-modal__section-title">🚀 Скорость и технологии</p>
              <ul className="dash-modal__list">
                <li>Потоковое видео в 4K и загрузка до 1 Гбит/с.</li>
                <li>Прямые каналы через европейские дата-центры для минимального пинга.</li>
                <li>Работа на базе самых современных сетевых протоколов.</li>
              </ul>
            </div>

            <div className="dash-modal__section">
              <p className="dash-modal__section-title">🔐 Безопасность и этика</p>
              <ul className="dash-modal__list">
                <li>
                  <strong>Строгая политика No-Logs:</strong> мы не храним историю ваших действий.
                </li>
                <li>Мощное шифрование и полная защита от утечек данных.</li>
                <li>Никакого спама, баннеров и слежки — только чистый интернет.</li>
                <li>Команда заботы, готовая прийти на помощь 24/7.</li>
              </ul>
            </div>
            <div className="dash-modal__stack" style={{ marginTop: 22 }}>
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="dash-modal-btn dash-modal-btn--ghost"
              >
                Условия использования
              </a>
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="dash-modal-btn dash-modal-btn--ghost"
              >
                Пользовательское соглашение
              </a>
              <a
                href="/policy"
                target="_blank"
                rel="noopener noreferrer"
                className="dash-modal-btn dash-modal-btn--ghost"
              >
                Политика конфиденциальности
              </a>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </LandingShell>
  );
};

export default Dashboard;
