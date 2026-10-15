import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowRight, Coins, Copy, Gift, Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { apiGet, apiPost } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { getReferralsProgramStarted, setReferralsProgramStarted } from "@/lib/referralsStorage";
import DashboardSidebar from "@/components/DashboardSidebar";
import { useDashboardSidebarItems } from "@/hooks/useDashboardSidebarItems";
import LandingShell from "@/pages/landing/LandingShell";
import LandingFooter from "@/pages/landing/LandingFooter";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

type ReferralPointItem = {
  id: number;
  amount: number;
  reason: string;
  referred_user_email?: string | null;
  meta?: {
    comment?: string;
    tier?: string;
    tariff_key?: string;
    is_first?: boolean;
    trigger?: string;
    days?: number;
  } | null;
  created_at: string;
};

type ReferralPointsResponse = {
  balance: number;
  items: ReferralPointItem[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  eligibility?: {
    active: boolean;
    reason: string | null;
  } | null;
};

type ReferralStatusResponse = {
  riskLevel: string;
  blocked: boolean;
  pointsBlocked?: boolean;
  status?: {
    pointsBlocked?: boolean;
  };
};

type ReferralExchangeRequest = {
  id: string;
  type: "days" | "prize";
  points: number;
  status: "pending" | "approved" | "rejected";
  operatorComment?: string | null;
  payload?: {
    days?: number;
    prizeId?: string;
    prizeTitle?: string;
    details?: string;
  };
  createdAt?: string | null;
  closedAt?: string | null;
};

type ReferralExchangeRequestsResponse = {
  items: ReferralExchangeRequest[];
};

type CreateReferralExchangeRequestResponse = {
  request: ReferralExchangeRequest;
};

const PAGE_SIZE = 20;
const POINTS_PER_DAY = 10;
const REFERRAL_EXCHANGE_BLOCKED_MESSAGE =
  "Списание/обмен баллов недоступны. Обратитесь в техническую поддержку.";
const REFERRAL_POINTS_BLOCKED_MESSAGE =
  "Начисление реферальных баллов для вашего аккаунта заблокировано. Новые регистрации и оплаты по вашей ссылке не будут приносить баллы.";

const PRIZE_OPTIONS = [
  {
    id: "airpods-3",
    title: "Apple AirPods 3",
    cost: 18000,
    hint: "Беспроводные наушники Apple",
  },
  {
    id: "phone-card-1000",
    title: "1000 руб на баланс телефона или карту",
    cost: 1000,
    hint: "Укажите телефон или реквизиты карты",
  },
  {
    id: "phone-card-500",
    title: "500 руб на баланс телефона или карту",
    cost: 500,
    hint: "Укажите телефон или реквизиты карты",
  },
] as const;

const FLOW_STEPS = [
  {
    num: 1,
    Icon: UserPlus,
    title: "Приглашай друзей",
    desc: "Поделись своей уникальной реферальной ссылкой с друзьями, коллегами и подписчиками",
  },
  {
    num: 2,
    Icon: Coins,
    title: "Зарабатывай баллы",
    desc: "+1 балл за регистрацию и до +1200 баллов за первую оплату тарифа приглашённым другом",
  },
  {
    num: 3,
    Icon: Gift,
    title: "Получай дни или призы",
    desc: "Обменивай накопленные баллы на дополнительные дни подписки или ценные награды",
  },
] as const;

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatReason(item: ReferralPointItem): string {
  const comment = item.meta?.comment?.trim();
  if (comment) return comment;

  if (item.reason === "registration") {
    return "Регистрация реферала";
  }
  if (item.reason === "tariff_payment") {
    const tier = item.meta?.tier;
    const tierLabel =
      tier === "1m"
        ? "1 мес."
        : tier === "6m"
          ? "6 мес."
          : tier === "12m"
            ? "12 мес."
            : null;
    const suffix = tierLabel ? ` (${tierLabel})` : "";
    const first = item.meta?.is_first ? " — первая оплата" : "";
    return `Оплата тарифа реферала${suffix}${first}`;
  }
  if (item.reason === "exchange_for_days" || item.reason === "referral_exchange_days") {
    return "Обмен баллов на дни";
  }
  return item.reason || "—";
}

function formatReferredUserEmail(email: string | null | undefined): string {
  if (!email || typeof email !== "string") return "—";
  return email.trim() || "—";
}

function formatAmount(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  if (amount > 0) return `+${amount}`;
  return String(amount);
}

function formatExchangeRequestTitle(request: ReferralExchangeRequest): string {
  if (request.type === "days") {
    const days = request.payload?.days;
    return `Дни подписки${Number.isInteger(days) ? `: ${days}` : ""}`;
  }
  return request.payload?.prizeTitle || "Приз";
}

function formatExchangeRequestStatus(request: ReferralExchangeRequest): string {
  if (request.status === "approved") return "Одобрено";
  if (request.status === "rejected") return "Отклонено";
  return "На рассмотрении";
}

function formatExchangeRequestComment(request: ReferralExchangeRequest): string {
  return typeof request.operatorComment === "string" ? request.operatorComment.trim() : "";
}

function exchangeRequestDate(request: ReferralExchangeRequest): string | null | undefined {
  return request.closedAt || request.createdAt;
}

const Referrals = () => {
  const { email, items, handleLogout, userUuid, userLoading } = useDashboardSidebarItems();
  const [backendEligibility, setBackendEligibility] = useState<{ active: boolean; reason: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [balance, setBalance] = useState(0);
  const [historyItems, setHistoryItems] = useState<ReferralPointItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [pointsInfoOpen, setPointsInfoOpen] = useState(false);
  const [daysExchangeOpen, setDaysExchangeOpen] = useState(false);
  const [prizesOpen, setPrizesOpen] = useState(false);
  const [exchangeBlockedOpen, setExchangeBlockedOpen] = useState(false);
  const [exchangeStatusChecking, setExchangeStatusChecking] = useState(false);
  const [referralPointsBlocked, setReferralPointsBlocked] = useState(false);
  const [exchangeRequests, setExchangeRequests] = useState<ReferralExchangeRequest[]>([]);
  const [daysToExchange, setDaysToExchange] = useState("1");
  const [selectedPrizeId, setSelectedPrizeId] = useState<string | null>(null);
  const [prizeClaimDetails, setPrizeClaimDetails] = useState("");
  const [prizeError, setPrizeError] = useState("");
  const [programStarted, setProgramStarted] = useState(false);
  const [startedReady, setStartedReady] = useState(false);
  const copyButtonRef = useRef<HTMLButtonElement>(null);

  const referrerEligible = backendEligibility?.active;

  const referralLink =
    typeof window !== "undefined" && userUuid
      ? `${window.location.origin}/?ref=${encodeURIComponent(userUuid)}`
      : "";

  const fetchHistory = useCallback(async (pageNum: number) => {
    setLoading(true);
    setError("");
    try {
      const { data, error: apiError } = await apiGet<ReferralPointsResponse>(
        `/me/referrals/points?page=${pageNum}&limit=${PAGE_SIZE}`,
      );
      if (apiError) throw apiError;
      if (!data || typeof data !== "object") {
        throw new Error("Некорректный ответ сервера");
      }
      setBalance(typeof data.balance === "number" ? data.balance : 0);
      setHistoryItems(Array.isArray(data.items) ? data.items : []);
      setPage(typeof data.page === "number" ? data.page : pageNum);
      setTotalPages(typeof data.total_pages === "number" ? data.total_pages : 0);
      setTotal(typeof data.total === "number" ? data.total : 0);
      setBackendEligibility(data.eligibility || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки данных");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchExchangeRequests = useCallback(async () => {
    try {
      const { data, error: apiError } = await apiGet<ReferralExchangeRequestsResponse>(
        "/me/referrals/exchange-requests",
      );
      if (apiError) throw apiError;
      setExchangeRequests(Array.isArray(data?.items) ? data.items : []);
    } catch {
      // Заявки не должны ломать всю страницу; ошибки покажем при отправке новой заявки.
    }
  }, []);

  useEffect(() => {
    if (userLoading) return;
    if (!userUuid) {
      setStartedReady(true);
      return;
    }
    const started = getReferralsProgramStarted(userUuid);
    setProgramStarted(started);
    // Не трогаем здесь `loading`: им управляет только fetchHistory. Иначе повторный
    // прогон этого эффекта (например, когда useDashboardSidebarItems переключает
    // userLoading после своего /api/me) снова взводит loading=true уже после того,
    // как запрос истории завершился, а второй эффект не перезапрашивает — и спиннер
    // зависает навсегда (особенно при пустой истории).
    setStartedReady(true);
  }, [userLoading, userUuid]);

  useEffect(() => {
    if (!startedReady || !programStarted || !userUuid) return;
    void fetchHistory(1);
    void fetchExchangeRequests();
  }, [startedReady, programStarted, userUuid, fetchHistory, fetchExchangeRequests]);

  const handleStartProgram = () => {
    if (!userUuid) {
      toast.error("Не удалось начать — попробуйте обновить страницу");
      return;
    }
    setLoading(true);
    setReferralsProgramStarted(userUuid);
    setProgramStarted(true);
  };

  const handleCopyLink = () => {
    if (!referralLink) {
      toast.error("Реферальная ссылка недоступна");
      return;
    }

    void copyText(referralLink, copyButtonRef.current).then((ok) => {
      if (ok) {
        toast.success("Ссылка скопирована!", {
          style: { background: "#0a0a0a", color: "#fff", border: "1px solid #22c55e" },
        });
      } else {
        toast.error("Не удалось скопировать. Скопируйте вручную:", {
          description: referralLink,
          duration: 8000,
        });
      }
    });
  };

  const updateReferralBlockedStatus = useCallback((data: ReferralStatusResponse) => {
    setReferralPointsBlocked(data.pointsBlocked === true || data.status?.pointsBlocked === true);
  }, []);

  const fetchReferralStatus = useCallback(async () => {
    try {
      const { data, error: apiError } = await apiGet<ReferralStatusResponse>("/me/referrals/status");
      if (apiError) throw apiError;
      if (!data || typeof data !== "object") return;
      updateReferralBlockedStatus(data);
    } catch {
      // Статус нужен только для подсказки на странице; ошибки покажем при попытке обмена.
    }
  }, [updateReferralBlockedStatus]);

  const exchangeDays = Math.max(0, Number.parseInt(daysToExchange, 10) || 0);
  const exchangeDaysCost = exchangeDays * POINTS_PER_DAY;
  const selectedPrize = PRIZE_OPTIONS.find((prize) => prize.id === selectedPrizeId) ?? null;

  const showExchangeBlockedDialog = useCallback(() => {
    setDaysExchangeOpen(false);
    setPrizesOpen(false);
    setExchangeBlockedOpen(true);
  }, []);

  const checkReferralExchangeAllowed = useCallback(async () => {
    setExchangeStatusChecking(true);
    try {
      const { data, error: apiError } = await apiGet<ReferralStatusResponse>("/me/referrals/status");
      if (apiError) throw apiError;
      if (!data || typeof data !== "object") {
        throw new Error("Некорректный ответ сервера");
      }
      updateReferralBlockedStatus(data);
      if (data.blocked) {
        showExchangeBlockedDialog();
        return false;
      }
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось проверить статус пользователя");
      return false;
    } finally {
      setExchangeStatusChecking(false);
    }
  }, [showExchangeBlockedDialog, updateReferralBlockedStatus]);

  useEffect(() => {
    if (!startedReady || !userUuid) return;
    void fetchReferralStatus();
  }, [fetchReferralStatus, startedReady, userUuid]);

  const createExchangeRequest = useCallback(
    async (body: Record<string, unknown>) => {
      const { data, error: apiError } = await apiPost<CreateReferralExchangeRequestResponse>(
        "/me/referrals/exchange-requests",
        body,
      );
      if (apiError) throw apiError;
      if (!data?.request) {
        throw new Error("Некорректный ответ сервера");
      }
      toast.success("Заявка создана", {
        description: "Операторы обработают её в течение суток.",
      });
      void fetchHistory(1);
      void fetchExchangeRequests();
      return data.request;
    },
    [fetchExchangeRequests, fetchHistory],
  );

  const handleOpenDaysExchange = async () => {
    if (await checkReferralExchangeAllowed()) {
      setDaysExchangeOpen(true);
    }
  };

  const handleOpenPrizes = async () => {
    if (await checkReferralExchangeAllowed()) {
      setPrizesOpen(true);
      setSelectedPrizeId(null);
      setPrizeClaimDetails("");
      setPrizeError("");
    }
  };

  const handleExchangeDays = async () => {
    if (exchangeDays <= 0) {
      toast.error("Укажите количество дней для обмена");
      return;
    }
    if (exchangeDaysCost > balance) {
      toast.error("Недостаточно баллов для обмена", {
        description: `Нужно ${exchangeDaysCost}, доступно ${balance}.`,
      });
      return;
    }
    if (!(await checkReferralExchangeAllowed())) {
      return;
    }

    setExchangeStatusChecking(true);
    try {
      await createExchangeRequest({
        type: "days",
        days: exchangeDays,
        points: exchangeDaysCost,
      });
      setDaysExchangeOpen(false);
      setDaysToExchange("1");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось создать заявку");
    } finally {
      setExchangeStatusChecking(false);
    }
  };

  const handlePrizeSelect = (prizeId: string) => {
    const prize = PRIZE_OPTIONS.find((item) => item.id === prizeId);
    if (!prize) return;

    setSelectedPrizeId(prize.id);
    setPrizeClaimDetails("");

    if (prize.cost > balance) {
      const message = `Недостаточно баллов: нужно ${prize.cost}, доступно ${balance}.`;
      setPrizeError(message);
      toast.error(message);
      return;
    }

    setPrizeError("");
  };

  const handlePrizeSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPrize) return;

    if (selectedPrize.cost > balance) {
      const message = `Недостаточно баллов: нужно ${selectedPrize.cost}, доступно ${balance}.`;
      setPrizeError(message);
      toast.error(message);
      return;
    }

    if (!prizeClaimDetails.trim()) {
      toast.error("Укажите данные для получения приза");
      return;
    }
    if (!(await checkReferralExchangeAllowed())) {
      return;
    }

    setExchangeStatusChecking(true);
    try {
      await createExchangeRequest({
        type: "prize",
        prizeId: selectedPrize.id,
        prizeTitle: selectedPrize.title,
        details: prizeClaimDetails.trim(),
        points: selectedPrize.cost,
      });
      setPrizesOpen(false);
      setSelectedPrizeId(null);
      setPrizeClaimDetails("");
      setPrizeError("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось создать заявку");
    } finally {
      setExchangeStatusChecking(false);
    }
  };

  const showPageLoader = userLoading || !startedReady;
  const showDetailsLoader = programStarted && loading && historyItems.length === 0 && !error;

  return (
    <LandingShell className="landing-root--with-sidebar landing-root--referrals">
      <DashboardSidebar
        items={items}
        onLogout={handleLogout}
        email={email || undefined}
        mobileTitle="Реферальная программа"
      />

      <main>
        <section className="app-page">
          <div className="container">
            <header className="dash-topbar">
              <div className="dash-topbar__lead">
                <span className="dash-topbar__kicker">Реферальная программа</span>
                <h1 className="dash-topbar__title">Приглашай. Зарабатывай. Получай призы.</h1>
                <p className="dash-topbar__email">
                  Делись своей ссылкой, копи баллы за активность друзей и обменивай их на дни
                  подписки или подарки.
                </p>
              </div>
            </header>

            {programStarted && referrerEligible === false && !showPageLoader && (
              <div className="mb-6 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-500 text-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex-1">
                  <p className="font-semibold mb-1">Реферальная программа приостановлена</p>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    Баллы начисляются только при наличии активного платного тарифа. Оплатите тариф, чтобы возобновить начисления — пропущенные за время паузы баллы не восстанавливаются.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => window.location.href = "/tariff"}
                  className="px-4 py-2 bg-yellow-500 text-black hover:bg-yellow-400 font-medium rounded-md transition-colors text-center shrink-0"
                >
                  Оплатить тариф
                </button>
              </div>
            )}

            {programStarted && referralPointsBlocked && !showPageLoader && (
              <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
                <p className="mb-1 font-semibold">Начисление реферальных баллов заблокировано</p>
                <p className="text-xs leading-relaxed text-red-100/80">
                  {REFERRAL_POINTS_BLOCKED_MESSAGE} Если вы считаете, что это ошибка, обратитесь в техническую поддержку.
                </p>
              </div>
            )}

            {showPageLoader ? (
              <div className="app-page__notice app-page__notice--loader">
                <Loader2 className="h-8 w-8 animate-spin" aria-label="Загрузка" />
              </div>
            ) : (
              <>
                {!programStarted ? (
                  <>
                    <section className="dash-referrals-flow" aria-label="Как работает программа">
                      {FLOW_STEPS.map((step, idx) => (
                        <Fragment key={step.num}>
                          <article className="dash-referrals-flow__step">
                            <span className="dash-referrals-flow__num">0{step.num}</span>
                            <span className="dash-referrals-flow__icon" aria-hidden="true">
                              <step.Icon className="h-6 w-6" />
                            </span>
                            <h2 className="dash-referrals-flow__title">{step.title}</h2>
                            <p className="dash-referrals-flow__desc">{step.desc}</p>
                          </article>
                          {idx < FLOW_STEPS.length - 1 ? (
                            <span className="dash-referrals-flow__arrow" aria-hidden="true">
                              <ArrowRight className="h-5 w-5" />
                            </span>
                          ) : null}
                        </Fragment>
                      ))}
                    </section>

                    <div className="dash-referrals-start">
                      <button type="button" className="dash-hero__cta" onClick={handleStartProgram}>
                        Начать
                      </button>
                    </div>
                  </>
                ) : showDetailsLoader ? (
                  <div className="dash-referrals-details-loader">
                    <Loader2 className="h-8 w-8 animate-spin" aria-label="Загрузка данных" />
                  </div>
                ) : error ? (
                  <div className="app-page__notice dash-referrals-details-error">
                    <p>{error}</p>
                    <button type="button" className="btn btn--primary" onClick={() => void fetchHistory(page)}>
                      Повторить
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="dash-grid">
                  <section className="dash-card">
                    <header className="dash-card__head">
                      <div className="dash-card__icon" aria-hidden="true">
                        <Coins className="h-5 w-5" />
                      </div>
                      <div className="dash-card__head-text">
                        <div className="dash-card__title">Ваши баллы</div>
                        <div className="dash-card__desc">
                          Начисляются за регистрацию и оплату тарифов друзьями
                        </div>
                      </div>
                    </header>
                    <div className="dash-card__body dash-card__body--center">
                      <div className="dash-metric">
                        <span className="dash-metric__value">{balance}</span>
                      </div>
                      <p className="dash-card__hint">
                        За регистрацию реферала — <strong>1</strong> балл. За первую оплату тарифа —
                        до <strong>1200</strong> баллов в зависимости от срока.{" "}
                        <button
                          type="button"
                          className="dash-referrals-more-link"
                          onClick={() => setPointsInfoOpen(true)}
                        >
                          Подробнее
                        </button>
                      </p>
                    </div>
                  </section>

                  <section className="dash-card">
                    <header className="dash-card__head">
                      <div className="dash-card__icon" aria-hidden="true">
                        <Copy className="h-5 w-5" />
                      </div>
                      <div className="dash-card__head-text">
                        <div className="dash-card__title">Ваша реф. ссылка</div>
                        <div className="dash-card__desc">Поделитесь ссылкой с друзьями и коллегами</div>
                      </div>
                    </header>
                    <div className="dash-card__body">
                      <div className="dash-referrals-rewards dash-referrals-rewards--single">
                        <button
                          ref={copyButtonRef}
                          type="button"
                          onClick={handleCopyLink}
                          disabled={!referralLink}
                          className="dash-referrals-rewards__btn"
                        >
                          Скопировать
                        </button>
                      </div>
                      <p className="dash-referrals-rewards__hint">(нажмите, чтобы скопировать)</p>
                    </div>
                  </section>

                  <section className="dash-card">
                    <header className="dash-card__head">
                      <div className="dash-card__icon" aria-hidden="true">
                        <Gift className="h-5 w-5" />
                      </div>
                      <div className="dash-card__head-text">
                        <div className="dash-card__title">Обмен баллов</div>
                        <div className="dash-card__desc">
                          Обменяй баллы на дни подписки или ценные призы
                        </div>
                      </div>
                    </header>
                    <div className="dash-card__body">
                      <div className="dash-referrals-rewards">
                        <button
                          type="button"
                          className="dash-referrals-rewards__btn"
                          onClick={() => void handleOpenDaysExchange()}
                          disabled={exchangeStatusChecking}
                        >
                          {exchangeStatusChecking ? "Проверяем..." : "Дни"}
                        </button>
                        <button
                          type="button"
                          className="dash-referrals-rewards__btn"
                          onClick={() => void handleOpenPrizes()}
                          disabled={exchangeStatusChecking}
                        >
                          {exchangeStatusChecking ? "Проверяем..." : "Призы"}
                        </button>
                      </div>
                      <p className="dash-referrals-rewards__hint">
                        10 баллов = 1 день. Призы можно выбрать из списка.
                      </p>
                    </div>
                  </section>
                </div>

                {exchangeRequests.length > 0 ? (
                  <section className="dash-card dash-referrals-requests-card">
                    <header className="dash-card__head">
                      <div className="dash-card__head-text">
                        <div className="dash-card__title">Активные заявки</div>
                        <div className="dash-card__desc">Активные и отклонённые за 30 дней</div>
                      </div>
                    </header>
                    <div className="dash-card__body">
                      <div className="dash-referrals-requests" aria-label="Активные заявки на обмен">
                        {exchangeRequests.map((request) => {
                          const comment = formatExchangeRequestComment(request);
                          const requestDate = exchangeRequestDate(request);
                          return (
                            <div
                              className={`dash-referrals-requests__item${
                                request.status === "rejected" ? " dash-referrals-requests__item--rejected" : ""
                              }`}
                              key={request.id}
                            >
                              <div className="dash-referrals-requests__content">
                                <div className="dash-referrals-requests__main">
                                  <strong>{formatExchangeRequestTitle(request)}</strong>
                                  <span className="dash-referrals-requests__points">{request.points} баллов</span>
                                </div>
                                <div className="dash-referrals-requests__meta">{formatExchangeRequestStatus(request)}</div>
                                {comment ? <div className="dash-referrals-requests__comment">{comment}</div> : null}
                              </div>
                              <time dateTime={requestDate || undefined}>
                                {requestDate ? formatDateTime(requestDate) : "—"}
                              </time>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                ) : null}

                <section className="dash-card dash-referrals-history">
                  <header className="dash-card__head">
                    <div className="dash-card__head-text">
                      <div className="dash-card__title">История начислений</div>
                      <div className="dash-card__desc">
                        {total > 0
                          ? `Всего записей: ${total}`
                          : "Пока никто не зарегистрировался по вашей ссылке"}
                      </div>
                    </div>
                  </header>
                  <div className="dash-card__body">
                    {historyItems.length === 0 ? (
                      <p className="dash-modal__empty">Начислений пока нет</p>
                    ) : (
                      <div className="dash-referrals-table-wrap">
                        <table className="dash-referrals-table">
                          <thead>
                            <tr>
                              <th>Дата</th>
                              <th>Событие</th>
                              <th>Реферал</th>
                              <th>Баллы</th>
                            </tr>
                          </thead>
                          <tbody>
                            {historyItems.map((item) => (
                              <tr key={item.id}>
                                <td>{formatDateTime(item.created_at)}</td>
                                <td>{formatReason(item)}</td>
                                <td>{formatReferredUserEmail(item.referred_user_email)}</td>
                                <td
                                  className={
                                    item.amount >= 0
                                      ? "dash-referrals-table__amount--plus"
                                      : "dash-referrals-table__amount--minus"
                                  }
                                >
                                  {formatAmount(item.amount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {totalPages > 1 ? (
                      <div className="dash-referrals-pagination">
                        <button
                          type="button"
                          className="dash-modal-btn dash-modal-btn--ghost"
                          disabled={page <= 1 || loading}
                          onClick={() => void fetchHistory(page - 1)}
                        >
                          ← Назад
                        </button>
                        <span className="dash-referrals-pagination__info">
                          Страница {page} из {totalPages}
                        </span>
                        <button
                          type="button"
                          className="dash-modal-btn dash-modal-btn--ghost"
                          disabled={page >= totalPages || loading}
                          onClick={() => void fetchHistory(page + 1)}
                        >
                          Вперёд →
                        </button>
                      </div>
                    ) : null}
                  </div>
                </section>
                  </>
                )}
              </>
            )}
          </div>
        </section>
      </main>

      <LandingFooter />

      <Dialog open={pointsInfoOpen} onOpenChange={setPointsInfoOpen}>
        <DialogContent className="dash-modal max-h-[85dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Как начисляются баллы</DialogTitle>
            <DialogDescription>
              Баллы начисляются за действия пользователей, которые зарегистрировались по вашей реферальной
              ссылке
            </DialogDescription>
          </DialogHeader>
          <div className="dash-modal__section">
            <p className="dash-modal__section-title">Регистрация</p>
            <ul className="dash-modal__list">
              <li>
                <strong>+1 балл</strong> — когда приглашённый пользователь впервые регистрируется по вашей
                ссылке
              </li>
            </ul>
          </div>
          <div className="dash-modal__section">
            <p className="dash-modal__section-title">Первая оплата тарифа рефералом</p>
            <ul className="dash-modal__list">
              <li>
                <strong>+100 баллов</strong> — тариф на 1 месяц
              </li>
              <li>
                <strong>+600 баллов</strong> — тариф на 6 месяцев
              </li>
              <li>
                <strong>+1200 баллов</strong> — тариф на 12 месяцев
              </li>
            </ul>
          </div>
          <div className="dash-modal__section">
            <p className="dash-modal__section-title">Повторные оплаты</p>
            <ul className="dash-modal__list">
              <li>
                При каждой следующей оплате тарифа тем же рефералом начисляется <strong>10%</strong> от
                баллов первой оплаты соответствующего срока (10 / 60 / 120 баллов)
              </li>
            </ul>
          </div>
          <div className="dash-modal__section">
            <p className="dash-modal__section-title">Важно</p>
            <ul className="dash-modal__list">
              <li>
                <strong>Активный тариф</strong> — баллы начисляются только при наличии у вас (реферера) активного платного тарифа. Если ваш тариф истёк или не оплачен, реферальная программа приостанавливается, а пропущенные за время паузы начисления не восстанавливаются.
              </li>
              <li>Баллы начисляются только за оплату подписочных тарифов, не за докупку трафика</li>
              <li>История всех начислений доступна в таблице ниже на этой странице</li>
              <li>
                Реферальная активность должна быть честной: ориентир — минимум одна реальная оплата на
                каждые 10 регистраций
              </li>
              <li>
                Запрещены накрутка баллов через фейковые аккаунты, фиктивные оплаты, оплаты с последующим
                возвратом и другие злоупотребления. При нарушениях участие в реферальной программе может
                быть аннулировано и закрыто для пользователя
              </li>
            </ul>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={daysExchangeOpen} onOpenChange={setDaysExchangeOpen}>
        <DialogContent className="dash-modal max-h-[85dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Обмен баллов на дни</DialogTitle>
            <DialogDescription>
              Курс обмена: <span className="dash-modal__desc-accent">10 баллов = 1 день</span>.
              Сейчас доступно {balance} баллов.
            </DialogDescription>
          </DialogHeader>

          <div className="dash-modal__section">
            <label className="dash-modal__panel-label" htmlFor="referral-days-exchange">
              Количество дней
            </label>
            <input
              id="referral-days-exchange"
              className="dash-modal__input"
              type="number"
              inputMode="numeric"
              pattern="[0-9]*"
              min="1"
              step="1"
              value={daysToExchange}
              onChange={(event) => setDaysToExchange(event.target.value)}
            />
            <p className="dash-modal__panel-hint">
              Будет списано {exchangeDaysCost} баллов
              {exchangeDaysCost > balance ? `, не хватает ${exchangeDaysCost - balance}` : ""}.
            </p>
          </div>

          <button
            type="button"
            className="dash-modal-btn dash-modal-btn--primary"
            onClick={() => void handleExchangeDays()}
            disabled={exchangeStatusChecking}
          >
            {exchangeStatusChecking ? "Проверяем..." : "Обменять"}
          </button>
        </DialogContent>
      </Dialog>

      <Dialog open={prizesOpen} onOpenChange={setPrizesOpen}>
        <DialogContent className="dash-modal max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Обмен баллов на призы</DialogTitle>
            <DialogDescription>
              Выберите приз. Если баллов достаточно, откроется форма для данных получения. Баланс:{" "}
              {balance} баллов.
            </DialogDescription>
          </DialogHeader>

          <div className="dash-modal__stack">
            {PRIZE_OPTIONS.map((prize) => (
              <button
                key={prize.id}
                type="button"
                className="dash-modal__item dash-modal__item--button"
                onClick={() => handlePrizeSelect(prize.id)}
              >
                <span className="dash-modal__item-meta">
                  <span className="dash-modal__item-title">{prize.title}</span>
                  <span className="dash-modal__item-sub">{prize.hint}</span>
                </span>
                <span className="dash-modal__item-price">{prize.cost} баллов</span>
              </button>
            ))}
          </div>

          {prizeError ? <p className="dash-modal__error">{prizeError}</p> : null}

          {selectedPrize && selectedPrize.cost <= balance ? (
            <form className="dash-modal__section" onSubmit={handlePrizeSubmit}>
              <p className="dash-modal__section-title">Данные для получения</p>
              <p className="dash-modal__item-sub">
                Выбран приз: {selectedPrize.title} за {selectedPrize.cost} баллов.
              </p>
              <textarea
                className="dash-modal__input dash-modal__textarea"
                value={prizeClaimDetails}
                onChange={(event) => setPrizeClaimDetails(event.target.value)}
                placeholder="Например: телефон, номер карты или удобный способ связи"
                rows={4}
              />
              <button type="submit" className="dash-modal-btn dash-modal-btn--primary" disabled={exchangeStatusChecking}>
                {exchangeStatusChecking ? "Проверяем..." : "Отправить заявку"}
              </button>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={exchangeBlockedOpen} onOpenChange={setExchangeBlockedOpen}>
        <DialogContent className="dash-modal sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Обмен недоступен</DialogTitle>
            <DialogDescription>{REFERRAL_EXCHANGE_BLOCKED_MESSAGE}</DialogDescription>
          </DialogHeader>
          <button
            type="button"
            className="dash-modal-btn dash-modal-btn--primary"
            onClick={() => setExchangeBlockedOpen(false)}
          >
            Понятно
          </button>
        </DialogContent>
      </Dialog>
    </LandingShell>
  );
};

export default Referrals;
