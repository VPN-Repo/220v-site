import { type FormEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, GitBranch, Info, RefreshCw, SlidersHorizontal } from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import AdminPageShell from "@/components/AdminPageShell";
import { Badge } from "@/components/ui/badge";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ADMIN_TOKEN_STORAGE_KEY } from "@/lib/admin";
import { apiBase } from "@/lib/api";
import { formatUserError } from "@/lib/errorMessages";
import { cn } from "@/lib/utils";

type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

type CounterEntry = { key: string; count: number };

type ReferralCounts = {
  clicks: number;
  codes: number;
  verifies: number;
  checkouts: number;
  creditSkipped: number;
  selfReferrals: number;
};

type ReferralEvent = {
  id?: string;
  type?: string;
  at?: string;
  referrerUuid?: string;
  referredEmailHash?: string;
  referredUuidPrefix?: string;
  ipHash?: string;
  uaHash?: string;
  fingerprintHash?: string;
  otherUserUuidPrefix?: string;
  selfReferral?: boolean;
  path?: string;
  reason?: string;
  tariffKey?: string;
};

type HashMatchSignals = {
  ua: boolean;
  fp: boolean;
  ip: boolean;
};

type HashMatchEntry = {
  otherUserUuidPrefix?: string;
  referredUuidPrefix?: string;
  referredEmailHash?: string;
  referredUuidPrefixA?: string;
  referredUuidPrefixB?: string;
  referredEmailHashA?: string;
  referredEmailHashB?: string;
  signals?: HashMatchSignals;
  uaHash?: string;
  fingerprintHash?: string;
  ipHash?: string;
};

type ReferralWarning = {
  code: string;
  label: string;
  severity: RiskLevel;
  evidence: Record<string, unknown> & { matches?: HashMatchEntry[] };
  description?: string;
};

const DYNAMIC_MATCH_CODES = new Set([
  "other_account_click_before_registration",
  "duplicate_registration_signals",
]);

const SPOILER_SEVERITIES: Array<"critical" | "high" | "medium"> = ["critical", "high", "medium"];

type ReferralUserStatus = {
  penalized: boolean;
  pointsBlocked: boolean;
  penalizedAt?: string | null;
  pointsBlockedAt?: string | null;
  lastDebitAt?: string | null;
  lastDebitAmount?: number | null;
  lastDebitComment?: string | null;
  exchangeAllowed?: boolean;
  exchangeAllowActive?: boolean;
  exchangeAllowComment?: string | null;
  exchangeAllowedAt?: string | null;
  exchangeAllowedUntil?: string | null;
  exchangeAllowRevokedAt?: string | null;
  updatedAt?: string | null;
};

type DailyRegistration = {
  date: string;
  registrations: number;
  suspicious: number;
};

type ReferrerRisk = {
  referrerUuid: string;
  riskLevel: RiskLevel;
  riskScore: number;
  warnings: ReferralWarning[];
  counts: ReferralCounts;
  unique: {
    ipHashes: number;
    userAgentHashes: number;
    fingerprintHashes: number;
    referredEmailHashes: number;
    referredUuidPrefixes: number;
  };
  lastSeen?: string | null;
  events: ReferralEvent[];
  status?: ReferralUserStatus;
  warningsBySeverity?: Record<"critical" | "high" | "medium", ReferralWarning[]>;
};

type ReferrerUserLookup = {
  loading: boolean;
  email?: string | null;
  status?: ReferralUserStatus;
  subscription?: {
    plan: string | null;
    expiresAt: string | null;
    status: string | null;
  } | null;
  error?: string;
};

type ReferrerBalanceLookup = {
  loading: boolean;
  balance?: number | null;
  error?: string;
};

type ReferredEmailLookup = {
  loading: boolean;
  byHash: Record<string, string>;
  error?: string;
};

type RegistrationRiskSignals = {
  signals: HashMatchSignals;
  severity: RiskLevel | null;
  duplicateRegistrations: number;
  otherAccounts: number;
};

type ReferralPointItem = {
  id: number | string;
  amount: number;
  reason: string;
  referred_user_email?: string | null;
  referred_email_hash?: string | null;
  risk?: RegistrationRiskSignals | null;
  meta?: {
    tier?: string;
    tariff_key?: string;
    is_first?: boolean;
    trigger?: string;
    comment?: string;
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

type DebitReferralPointsResponse = {
  transaction?: ReferralPointItem;
  balance?: number;
  status?: ReferralUserStatus;
};

type ReferralExchangeRequest = {
  id: string;
  referrerUuid: string;
  email?: string | null;
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

type ReferralExchangeActionResponse = {
  request?: ReferralExchangeRequest;
  debit?: {
    balance?: number;
  };
  exchange?: {
    balance?: number;
  };
};

type ReferralSummary = {
  generatedAt: string;
  window: { days: number | null; since: string | null; until: string };
  totals: {
    events: number;
    referrers: number;
    suspiciousReferrers: number;
    criticalHighWarnings: number;
    selfReferrals: number;
    multiAccountDetections: number;
  };
  funnel: ReferralCounts;
  riskSummary: Record<RiskLevel, number>;
  referrers: ReferrerRisk[];
  topIps: CounterEntry[];
  topUserAgents: CounterEntry[];
  topFingerprints: CounterEntry[];
  dailyRegistrations: DailyRegistration[];
  events: ReferralEvent[];
};

const RISK_LABELS: Record<RiskLevel, string> = {
  critical: "Критичный",
  high: "Высокий",
  medium: "Средний",
  low: "Низкий",
  none: "Нет",
};

const RISK_REFERRERS_GRID_CLASS =
  "grid grid-cols-1 gap-2 lg:grid-cols-[minmax(145px,1.2fr)_minmax(160px,1fr)_80px_72px_120px_125px_92px_118px] lg:items-center";

const EVENT_LABELS: Record<string, string> = {
  ref_click: "Переход",
  ref_send_code: "Код",
  ref_verify_ok: "Регистрация",
  ref_checkout_by_referred: "Checkout",
  ref_credit_skipped: "Пропуск",
  ref_self_referral: "Self-referral",
};

const EVENT_FILTERS = [
  { value: "all", label: "Все события" },
  { value: "ref_click", label: "Переходы" },
  { value: "ref_send_code", label: "Коды" },
  { value: "ref_verify_ok", label: "Регистрации" },
  { value: "ref_checkout_by_referred", label: "Checkout" },
  { value: "ref_credit_skipped", label: "Пропуски" },
  { value: "ref_self_referral", label: "Self-referral" },
];

const HISTORY_PAGE_SIZE = 20;
const REFERRED_EMAIL_LOOKUP_LIMIT = 100;
const REFERRER_DETAILS_BATCH_SIZE = 8;
const DEFAULT_EXCHANGE_APPROVE_COMMENT = "Обмен баллов пользователем";
const DEFAULT_EXCHANGE_REJECT_COMMENT = "Отклонено оператором";

const DAILY_REGISTRATIONS_CHART_CONFIG = {
  registrations: {
    label: "Регистрации",
    color: "hsl(var(--primary))",
  },
  suspicious: {
    label: "Подозрительные",
    color: "hsl(var(--destructive))",
  },
} satisfies ChartConfig;

const RISK_TOTAL_HINTS = {
  events: {
    label: "События",
    description:
      "Все реферальные события за выбранный период: переходы по ссылке, отправки кодов, регистрации, checkout, пропуски начислений и self-referral события.",
  },
  referrers: {
    label: "Рефереры",
    description: "Количество уникальных UUID рефереров, у которых есть реферальные события в выбранном периоде.",
  },
  suspiciousReferrers: {
    label: "Подозрительные",
    description: "Рефереры с итоговым уровнем риска medium, high или critical.",
  },
  criticalHighWarnings: {
    label: "Critical/High",
    description: "Общее число warning-ов с severity critical или high среди всех рефереров в выборке.",
  },
  selfReferrals: {
    label: "Self-referrals",
    description: "События, где пользователь попытался пройти по собственной реферальной цепочке.",
  },
  multiAccountDetections: {
    label: "Multi-account",
    description:
      "Сколько раз найден сценарий, где ссылка открывалась из браузера/ПК другого аккаунта, а затем был зарегистрирован реферал с совпадающим браузерным сигналом.",
  },
} satisfies Record<keyof ReferralSummary["totals"], { label: string; description: string }>;

const RISK_FUNNEL_HINTS = {
  clicks: {
    label: "Clicks",
    description: "Переходы по реферальным ссылкам за выбранный период.",
  },
  codes: {
    label: "Codes",
    description: "Отправки или вводы реферального кода в процессе регистрации.",
  },
  verifies: {
    label: "Verifies",
    description: "Успешные подтверждения регистрации, привязанные к реферальной цепочке.",
  },
  checkouts: {
    label: "Checkouts",
    description: "Оплаты или checkout-события пользователей, пришедших по реферальной цепочке.",
  },
  creditSkipped: {
    label: "Skipped",
    description: "События, где реферальное начисление было пропущено backend-логикой.",
  },
  selfReferrals: {
    label: "Self",
    description: "Self-referral события внутри воронки: попытки пройти по собственной реферальной цепочке.",
  },
} satisfies Record<keyof ReferralCounts, { label: string; description: string }>;

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU");
}

function formatSubscriptionStatus(subscription?: ReferrerUserLookup["subscription"]): string {
  if (!subscription) return "—";
  const expiresAtMs = subscription.expiresAt ? Date.parse(subscription.expiresAt) : Number.NaN;
  if (subscription.status?.toUpperCase() === "EXPIRED" || (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now())) {
    return "Истёк";
  }
  if (subscription.status?.toUpperCase() === "ACTIVE" || (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now())) {
    return "Активен";
  }
  return "—";
}

function asErrorMessage(error: unknown) {
  return formatUserError(error, "Не удалось загрузить данные");
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value > 0 ? `+${value}` : String(value);
}

function formatReferralPointReason(item: ReferralPointItem): string {
  if (item.reason === "registration") return "Регистрация реферала";
  if (item.reason === "tariff_payment") {
    const tier = item.meta?.tier;
    const tierLabel =
      tier === "1m" ? "1 мес." : tier === "6m" ? "6 мес." : tier === "12m" ? "12 мес." : null;
    const suffix = tierLabel ? ` (${tierLabel})` : "";
    const first = item.meta?.is_first ? " — первая оплата" : "";
    return `Оплата тарифа реферала${suffix}${first}`;
  }
  if (item.reason === "manual_debit") {
    const comment = item.meta?.comment?.trim();
    return comment ? `Списание баллов: ${comment}` : "Списание баллов";
  }
  if (item.reason === "exchange_for_days" || item.reason === "referral_exchange_days") {
    return "Обмен баллов на дни";
  }
  const comment = item.meta?.comment?.trim();
  if (comment) return comment;
  return item.reason || "—";
}

function formatExchangeRequestKind(request: ReferralExchangeRequest): string {
  if (request.type === "days") {
    return `Дни подписки${Number.isInteger(request.payload?.days) ? `: ${request.payload?.days}` : ""}`;
  }
  return request.payload?.prizeTitle || "Приз";
}

function formatExchangeRequestDetails(request: ReferralExchangeRequest): string {
  if (request.type === "days") {
    return "Оператор вручную добавляет дни подписки после одобрения.";
  }
  return request.payload?.details || "Данные получения не указаны";
}

function hasReferralStatus(status?: ReferralUserStatus | null): status is ReferralUserStatus {
  return Boolean(status?.penalized || status?.pointsBlocked || status?.exchangeAllowActive);
}

function ReferralStatusBadges({ status }: { status?: ReferralUserStatus | null }) {
  if (!hasReferralStatus(status)) return null;

  return (
    <span className="inline-flex flex-wrap gap-1">
      {status.penalized ? (
        <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-700">
          Оштрафован
        </Badge>
      ) : null}
      {status.pointsBlocked ? (
        <Badge variant="destructive">
          Заблокирован
        </Badge>
      ) : null}
      {status.exchangeAllowActive ? (
        <Badge variant="outline" className="border-emerald-500/50 bg-emerald-500/10 text-emerald-700">
          Обмен разрешён
        </Badge>
      ) : null}
    </span>
  );
}

// `datetime-local` inputs work in local time, while the API stores ISO/UTC.
function toDateTimeLocalValue(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatChartDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function riskClass(level: RiskLevel) {
  if (level === "critical") return "border-red-600 bg-red-600 text-white";
  if (level === "high") return "border-orange-500 bg-orange-500 text-white";
  if (level === "medium") return "border-amber-500 bg-amber-100 text-amber-900";
  if (level === "low") return "border-emerald-500 bg-emerald-50 text-emerald-800";
  return "border-border bg-muted text-muted-foreground";
}

function riskDotClass(level: RiskLevel) {
  if (level === "critical") return "border-red-700 bg-red-600";
  if (level === "high") return "border-orange-600 bg-orange-500";
  if (level === "medium") return "border-amber-600 bg-amber-400";
  if (level === "low") return "border-emerald-600 bg-emerald-500";
  return "border-muted-foreground bg-muted";
}

function shortenUuid(value: string) {
  if (value.length <= 20) return value;
  return `${value.slice(0, 9)}...${value.slice(-8)}`;
}

function shortenHash(value?: string | null, length = 8) {
  if (!value) return "—";
  return value.length <= length ? value : value.slice(0, length);
}

async function copyToClipboard(value: string, label: string) {
  const text = value.trim();
  if (!text || text === "—") return;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (!copied) throw new Error("copy failed");
    }
    toast.success(`${label} скопирован`);
  } catch {
    toast.error(`Не удалось скопировать ${label.toLowerCase()}`);
  }
}

function StatCard({ label, value, description }: { label: string; value: number; description?: string }) {
  return (
    <div className="rounded-lg bg-muted px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs uppercase text-muted-foreground">{label}</p>
        {description ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-background hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                aria-label={`Описание: ${label}`}
              >
                <Info className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-left text-xs leading-snug">{description}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <p className="mt-1 text-xl font-bold text-foreground">{value}</p>
    </div>
  );
}

function RiskBadge({ level }: { level: RiskLevel }) {
  return <Badge className={cn("border", riskClass(level))}>{RISK_LABELS[level] || level}</Badge>;
}

function ScoreBadge({ score, level }: { score: number; level: RiskLevel }) {
  return (
    <Badge className={cn("min-w-10 justify-center border font-bold", riskClass(level))}>
      {score}
    </Badge>
  );
}

function CopyableText({
  value,
  label,
  displayValue = value,
  className,
}: {
  value: string;
  label: string;
  displayValue?: string;
  className?: string;
}) {
  const handleCopy = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void copyToClipboard(value, label);
  };

  return (
    <button
      type="button"
      title={`${value} — нажмите, чтобы скопировать`}
      className={cn(
        "inline-block max-w-full min-w-0 truncate text-left align-bottom font-mono text-xs font-semibold text-foreground underline-offset-2 transition hover:text-primary hover:underline",
        className,
      )}
      onClick={handleCopy}
    >
      {displayValue}
    </button>
  );
}

function HashText({
  value,
  label,
  length = 8,
  className,
}: {
  value?: string | null;
  label: string;
  length?: number;
  className?: string;
}) {
  if (!value) return <span className={cn("text-muted-foreground", className)}>—</span>;
  return (
    <CopyableText value={value} label={label} displayValue={shortenHash(value, length)} className={className} />
  );
}

function DailyRegistrationsChart({ data }: { data: DailyRegistration[] }) {
  const totalRegistrations = data.reduce((sum, item) => sum + item.registrations, 0);
  const totalSuspicious = data.reduce((sum, item) => sum + item.suspicious, 0);

  return (
    <section className="rounded-2xl bg-card p-4 ring-1 ring-border">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-foreground">Регистрации рефералов по дням</h2>
          <p className="text-sm text-muted-foreground">
            Подозрительные — регистрации от рефереров с риском medium и выше.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">Всего: {totalRegistrations}</Badge>
          <Badge className="bg-destructive text-destructive-foreground">Подозрительные: {totalSuspicious}</Badge>
        </div>
      </div>

      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Нет регистраций за выбранный период</p>
      ) : (
        <ChartContainer config={DAILY_REGISTRATIONS_CHART_CONFIG} className="h-[130px] w-full">
          <LineChart data={data} margin={{ left: 8, right: 8, top: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatChartDate} tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => (typeof value === "string" ? formatChartDate(value) : value)}
                />
              }
            />
            <Line
              type="monotone"
              dataKey="registrations"
              stroke="var(--color-registrations)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="suspicious"
              stroke="var(--color-suspicious)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ChartContainer>
      )}
    </section>
  );
}

function EventCard({ event }: { event: ReferralEvent }) {
  return (
    <div className="rounded-lg bg-muted p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs font-bold text-foreground">
          {EVENT_LABELS[event.type || ""] || event.type || "event"}
        </p>
        <span className="text-xs text-muted-foreground">{formatDate(event.at)}</span>
      </div>
      <p className="mt-1 break-all text-xs text-muted-foreground">
        referrer: {event.referrerUuid || "—"} · user: {event.referredUuidPrefix || "—"} · email hash:{" "}
        {event.referredEmailHash || "—"}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
        ip: <HashText value={event.ipHash} label="IP hash" /> · ua:{" "}
        <HashText value={event.uaHash} label="UA hash" /> · fp:{" "}
        <HashText value={event.fingerprintHash} label="FP hash" />
      </p>
      {(event.reason || event.tariffKey || event.selfReferral) && (
        <p className="mt-1 text-xs text-muted-foreground">
          reason: {event.reason || "—"} · tariff: {event.tariffKey || "—"} · self:{" "}
          {event.selfReferral ? "yes" : "no"}
        </p>
      )}
    </div>
  );
}

function ColumnHeaderHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help items-center gap-1">
          {label}
          <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1 text-left text-xs font-normal leading-snug">{children}</TooltipContent>
    </Tooltip>
  );
}

function WarningList({ warnings }: { warnings: ReferralWarning[] }) {
  if (warnings.length === 0) {
    return <span className="text-xs text-muted-foreground">Без warning-ов</span>;
  }
  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-nowrap items-center gap-1.5">
        {warnings.map((warning) => (
          <Tooltip key={`${warning.code}-${warning.severity}`}>
            <TooltipTrigger asChild>
              <span
                aria-label={warning.label}
                className={cn("h-3.5 w-3.5 shrink-0 rounded-full border shadow-sm", riskDotClass(warning.severity))}
              />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs space-y-1">
              <p className="font-medium">{warning.label}</p>
              {warning.description && <p className="text-xs leading-snug opacity-90">{warning.description}</p>}
              <p className="font-mono text-xs opacity-75">{warning.code}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

function MatchSignalChips({ signals }: { signals?: HashMatchSignals }) {
  if (!signals) return null;
  const entries: Array<[keyof HashMatchSignals, string]> = [
    ["ua", "UA"],
    ["fp", "FP"],
    ["ip", "IP"],
  ];
  return (
    <span className="inline-flex flex-wrap gap-1">
      {entries.map(([key, label]) => (
        <span
          key={key}
          className={cn(
            "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase",
            signals[key]
              ? "bg-red-100 text-red-800 ring-1 ring-red-300"
              : "bg-muted text-muted-foreground line-through opacity-60",
          )}
        >
          {label}
        </span>
      ))}
    </span>
  );
}

function matchReferredEmailHashes(match: HashMatchEntry) {
  return [match.referredEmailHash, match.referredEmailHashA, match.referredEmailHashB].filter(
    (hash): hash is string => typeof hash === "string" && hash.length > 0,
  );
}

function collectReferredEmailHashes(item: ReferrerRisk) {
  const hashes = new Set<string>();
  for (const warning of item.warnings) {
    if (!DYNAMIC_MATCH_CODES.has(warning.code) || !Array.isArray(warning.evidence?.matches)) continue;
    for (const match of warning.evidence.matches) {
      matchReferredEmailHashes(match).forEach((hash) => hashes.add(hash));
    }
  }
  return hashes;
}

function hasAllReferredEmails(lookup: ReferredEmailLookup | undefined, hashes: Set<string>) {
  if (!lookup || lookup.loading) return false;
  for (const hash of hashes) {
    if (!lookup.byHash[hash]) return false;
  }
  return true;
}

function ReferredMatchValue({
  fallback,
  emailHash,
  lookup,
}: {
  fallback: string;
  emailHash?: string;
  lookup?: ReferredEmailLookup;
}) {
  const email = emailHash ? lookup?.byHash[emailHash] : undefined;
  if (email) {
    return <CopyableText value={email} label="Email" className="max-w-[220px] align-baseline" />;
  }
  if (emailHash && lookup?.loading) {
    return <span className="text-muted-foreground">загрузка...</span>;
  }
  return <span className="font-mono text-foreground">{fallback}</span>;
}

function RegistrationRiskCell({ item }: { item: ReferralPointItem }) {
  if (item.reason !== "registration") {
    return null;
  }
  const risk = item.risk;
  if (!risk) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const hasMatches = Boolean(risk.severity);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help items-center gap-1.5">
          {hasMatches ? (
            <span
              aria-label={RISK_LABELS[risk.severity as RiskLevel]}
              className={cn("h-3 w-3 shrink-0 rounded-full border", riskDotClass(risk.severity as RiskLevel))}
            />
          ) : null}
          <MatchSignalChips signals={risk.signals} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1 text-left text-xs leading-snug">
        {hasMatches ? (
          <>
            <p className="font-medium">
              Совпадения технических отпечатков ({RISK_LABELS[risk.severity as RiskLevel].toLowerCase()})
            </p>
            {risk.duplicateRegistrations > 0 ? (
              <p>Других регистраций с совпавшими отпечатками: {risk.duplicateRegistrations}</p>
            ) : null}
            {risk.otherAccounts > 0 ? (
              <p>Ссылка открывалась из других аккаунтов с этими отпечатками: {risk.otherAccounts}</p>
            ) : null}
          </>
        ) : (
          <p>Совпадений UA/FP/IP с другими регистрациями этого реферера не найдено</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function HashMatchDetails({
  matches,
  referredEmailLookup,
}: {
  matches?: HashMatchEntry[];
  referredEmailLookup?: ReferredEmailLookup;
}) {
  if (!matches || matches.length === 0) return null;
  return (
    <div className="mt-2 space-y-2">
      {matches.map((match, index) => {
        const left = match.otherUserUuidPrefix ?? match.referredUuidPrefixA ?? "—";
        const right = match.referredUuidPrefix ?? match.referredUuidPrefixB ?? "—";
        const leftLabel = match.otherUserUuidPrefix ? "Аккаунт" : "Реферал A";
        const rightLabel = match.otherUserUuidPrefix ? "Реферал" : "Реферал B";
        const leftEmailHash = match.otherUserUuidPrefix ? undefined : match.referredEmailHashA;
        const rightEmailHash = match.referredEmailHash ?? match.referredEmailHashB;
        return (
          <div
            key={`${left}-${right}-${index}`}
            className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>
                {leftLabel}:{" "}
                <ReferredMatchValue fallback={left} emailHash={leftEmailHash} lookup={referredEmailLookup} />
              </span>
              <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>
                {rightLabel}:{" "}
                <ReferredMatchValue fallback={right} emailHash={rightEmailHash} lookup={referredEmailLookup} />
              </span>
              <MatchSignalChips signals={match.signals} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              {match.uaHash ? (
                <span>
                  ua: <HashText value={match.uaHash} label="UA hash" />
                </span>
              ) : null}
              {match.fingerprintHash ? (
                <span>
                  fp: <HashText value={match.fingerprintHash} label="FP hash" />
                </span>
              ) : null}
              {match.ipHash ? (
                <span>
                  ip: <HashText value={match.ipHash} label="IP hash" />
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WarningCard({
  warning,
  referredEmailLookup,
}: {
  warning: ReferralWarning;
  referredEmailLookup?: ReferredEmailLookup;
}) {
  const isDynamic = DYNAMIC_MATCH_CODES.has(warning.code);
  return (
    <div className="rounded-lg bg-background p-3 ring-1 ring-border">
      <div className="flex flex-wrap items-center gap-2">
        <RiskBadge level={warning.severity} />
        <span className="font-semibold text-foreground">{warning.label}</span>
        <span className="font-mono text-xs text-muted-foreground">{warning.code}</span>
      </div>
      {warning.description && <p className="mt-2 text-sm text-muted-foreground">{warning.description}</p>}
      {isDynamic && warning.evidence?.matches ? (
        <HashMatchDetails matches={warning.evidence.matches} referredEmailLookup={referredEmailLookup} />
      ) : (
        <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground">
          {JSON.stringify(warning.evidence, null, 2)}
        </pre>
      )}
    </div>
  );
}

function RiskWarningSpoilers({
  item,
  referredEmailLookup,
}: {
  item: ReferrerRisk;
  referredEmailLookup?: ReferredEmailLookup;
}) {
  const grouped =
    item.warningsBySeverity ??
    SPOILER_SEVERITIES.reduce(
      (acc, severity) => {
        acc[severity] = item.warnings.filter((warning) => warning.severity === severity);
        return acc;
      },
      { critical: [], high: [], medium: [] } as Record<"critical" | "high" | "medium", ReferralWarning[]>,
    );

  const hasAny = SPOILER_SEVERITIES.some((severity) => grouped[severity].length > 0);
  if (!hasAny) return null;

  return (
    <div className="mb-3 space-y-2">
      {SPOILER_SEVERITIES.map((severity) => {
        const warnings = grouped[severity];
        if (warnings.length === 0) return null;
        return (
          <details key={severity} className="group/spoiler rounded-lg ring-1 ring-border">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg p-3 text-sm hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
              <ChevronRight
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/spoiler:rotate-90"
                aria-hidden="true"
              />
              <span
                className={cn("h-3 w-3 shrink-0 rounded-full border", riskDotClass(severity))}
                aria-hidden="true"
              />
              <span className="font-semibold text-foreground">{RISK_LABELS[severity]}</span>
              <span className="text-xs text-muted-foreground">
                {warnings.length} {warnings.length === 1 ? "сигнал" : "сигналов"}
              </span>
            </summary>
            <div className="space-y-2 border-t border-border p-3">
              {warnings.map((warning) => (
                <WarningCard
                  key={`${warning.code}-${warning.severity}`}
                  warning={warning}
                  referredEmailLookup={referredEmailLookup}
                />
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function OtherEventsSpoiler({ events }: { events: ReferralEvent[] }) {
  return (
    <details className="group/other rounded-lg ring-1 ring-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg p-3 text-sm hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/other:rotate-90"
          aria-hidden="true"
        />
        <span className="font-semibold text-foreground">Другое</span>
        <span className="text-xs text-muted-foreground">Событий: {events.length}</span>
      </summary>
      <div className="space-y-2 border-t border-border p-3">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Нет событий выбранного типа</p>
        ) : (
          events.map((event, index) => <EventCard key={event.id || `${event.at}-${index}`} event={event} />)
        )}
      </div>
    </details>
  );
}

function ReferralUserWorkspace({
  items,
  eventType,
  token,
  filtersPanel,
  showReferrers,
  renderPage,
}: {
  items: ReferrerRisk[];
  eventType: string;
  token: string;
  filtersPanel: ReactNode;
  showReferrers: boolean;
  renderPage: (actions: { openHistory: (uuid: string) => void; openDebit: (uuid: string) => void }) => ReactNode;
}) {
  const [userLookups, setUserLookups] = useState<Record<string, ReferrerUserLookup>>({});
  const userLookupRequestIds = useRef<Record<string, number>>({});
  const [balanceLookups, setBalanceLookups] = useState<Record<string, ReferrerBalanceLookup>>({});
  const [referredEmailLookups, setReferredEmailLookups] = useState<Record<string, ReferredEmailLookup>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyUuid, setHistoryUuid] = useState("");
  const [historyData, setHistoryData] = useState<ReferralPointsResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const historyRequestId = useRef(0);
  const [successfulPayments, setSuccessfulPayments] = useState<{ loading: boolean; count: number | null; error: string }>({
    loading: false,
    count: null,
    error: "",
  });
  const paymentCountRequestId = useRef(0);
  const [debitOpen, setDebitOpen] = useState(false);
  const [debitUuid, setDebitUuid] = useState("");
  const [debitAmount, setDebitAmount] = useState("");
  const [debitComment, setDebitComment] = useState("");
  const [debitPointsBlocked, setDebitPointsBlocked] = useState(false);
  const [debitPenalized, setDebitPenalized] = useState(false);
  const [debitLoading, setDebitLoading] = useState(false);
  const [debitError, setDebitError] = useState("");
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [permissionUuid, setPermissionUuid] = useState("");
  const [permissionComment, setPermissionComment] = useState("");
  const [permissionExpiresAt, setPermissionExpiresAt] = useState("");
  const [permissionLoading, setPermissionLoading] = useState(false);
  const [permissionError, setPermissionError] = useState("");
  const [revokingUuid, setRevokingUuid] = useState("");
  const [statusOverrides, setStatusOverrides] = useState<Record<string, ReferralUserStatus>>({});
  const [detailsLoading, setDetailsLoading] = useState(false);
  const filtersRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!filtersOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (filtersRef.current && !filtersRef.current.contains(event.target as Node)) {
        setFiltersOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFiltersOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [filtersOpen]);

  const loadUserEmail = useCallback(
    async (uuid: string, refresh = false) => {
      const existing = userLookups[uuid];
      if (!refresh && (existing?.loading || existing?.email !== undefined)) return;
      const requestId = (userLookupRequestIds.current[uuid] || 0) + 1;
      userLookupRequestIds.current[uuid] = requestId;

      setUserLookups((prev) => ({
        ...prev,
        [uuid]: { ...(prev[uuid] || {}), loading: true, error: undefined },
      }));
      try {
        const res = await fetch(`${apiBase}/admin/referrals/users/${encodeURIComponent(uuid)}${refresh ? "?refresh=1" : ""}`, {
          headers: { "X-Admin-Token": token.trim() },
          credentials: "include",
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : `Ошибка ${res.status}`;
          throw new Error(message);
        }
        const email =
          body && typeof body === "object" && "email" in body && typeof body.email === "string"
            ? body.email
            : null;
        const status =
          body && typeof body === "object" && "status" in body && body.status && typeof body.status === "object"
            ? (body.status as ReferralUserStatus)
            : undefined;
        const subscription =
          body && typeof body === "object" && "subscription" in body && body.subscription && typeof body.subscription === "object"
            ? (body.subscription as ReferrerUserLookup["subscription"])
            : null;
        if (userLookupRequestIds.current[uuid] === requestId) {
          setUserLookups((prev) => ({ ...prev, [uuid]: { loading: false, email, status, subscription } }));
        }
      } catch (err) {
        if (userLookupRequestIds.current[uuid] === requestId) {
          setUserLookups((prev) => ({
            ...prev,
            [uuid]: { ...(prev[uuid] || {}), loading: false, subscription: null, error: asErrorMessage(err) },
          }));
        }
      }
    },
    [token, userLookups],
  );

  const loadUserBalance = useCallback(
    async (uuid: string) => {
      const existing = balanceLookups[uuid];
      if (existing?.loading || existing?.balance !== undefined) return;

      setBalanceLookups((prev) => ({ ...prev, [uuid]: { loading: true } }));
      try {
        const qs = new URLSearchParams({
          page: "1",
          limit: "1",
        });
        const res = await fetch(
          `${apiBase}/admin/referrals/users/${encodeURIComponent(uuid)}/points?${qs}`,
          {
            headers: { "X-Admin-Token": token.trim() },
            credentials: "include",
          },
        );
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : `Ошибка ${res.status}`;
          throw new Error(message);
        }
        const balance =
          body && typeof body === "object" && "balance" in body && typeof body.balance === "number"
            ? body.balance
            : null;
        setBalanceLookups((prev) => ({ ...prev, [uuid]: { loading: false, balance } }));
      } catch (err) {
        setBalanceLookups((prev) => ({ ...prev, [uuid]: { loading: false, error: asErrorMessage(err) } }));
      }
    },
    [balanceLookups, token],
  );

  const loadReferredEmails = useCallback(
    async (item: ReferrerRisk) => {
      const hashes = collectReferredEmailHashes(item);
      if (hashes.size === 0) return;

      const uuid = item.referrerUuid;
      const existing = referredEmailLookups[uuid];
      if (existing?.loading || hasAllReferredEmails(existing, hashes)) return;

      setReferredEmailLookups((prev) => ({
        ...prev,
        [uuid]: { loading: true, byHash: prev[uuid]?.byHash || {} },
      }));
      try {
        const qs = new URLSearchParams({
          page: "1",
          limit: String(REFERRED_EMAIL_LOOKUP_LIMIT),
        });
        const res = await fetch(
          `${apiBase}/admin/referrals/users/${encodeURIComponent(uuid)}/points?${qs}`,
          {
            headers: { "X-Admin-Token": token.trim() },
            credentials: "include",
          },
        );
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : `Ошибка ${res.status}`;
          throw new Error(message);
        }

        const data = body as Partial<ReferralPointsResponse> | null;
        const byHash: Record<string, string> = {};
        for (const point of Array.isArray(data?.items) ? data.items : []) {
          const emailHash = typeof point.referred_email_hash === "string" ? point.referred_email_hash : "";
          const email = typeof point.referred_user_email === "string" ? point.referred_user_email : "";
          if (emailHash && email) byHash[emailHash] = email;
        }
        setReferredEmailLookups((prev) => ({
          ...prev,
          [uuid]: {
            loading: false,
            byHash: { ...(prev[uuid]?.byHash || {}), ...byHash },
          },
        }));
      } catch (err) {
        setReferredEmailLookups((prev) => ({
          ...prev,
          [uuid]: {
            loading: false,
            byHash: prev[uuid]?.byHash || {},
            error: asErrorMessage(err),
          },
        }));
      }
    },
    [referredEmailLookups, token],
  );

  const loadVisibleReferrerDetails = useCallback(async () => {
    setDetailsLoading(true);
    try {
      for (let index = 0; index < items.length; index += REFERRER_DETAILS_BATCH_SIZE) {
        const batch = items.slice(index, index + REFERRER_DETAILS_BATCH_SIZE);
        await Promise.all(
          batch.map((item) =>
            Promise.all([
              loadUserEmail(item.referrerUuid),
              loadUserBalance(item.referrerUuid),
              loadReferredEmails(item),
            ]),
          ),
        );
      }
    } finally {
      setDetailsLoading(false);
    }
  }, [items, loadReferredEmails, loadUserBalance, loadUserEmail]);

  const loadReferralHistory = useCallback(
    async (uuid: string, pageNum = 1) => {
      const requestId = ++historyRequestId.current;
      setHistoryLoading(true);
      setHistoryError("");
      try {
        const qs = new URLSearchParams({
          page: String(pageNum),
          limit: String(HISTORY_PAGE_SIZE),
        });
        const res = await fetch(
          `${apiBase}/admin/referrals/users/${encodeURIComponent(uuid)}/points?${qs}`,
          {
            headers: { "X-Admin-Token": token.trim() },
            credentials: "include",
          },
        );
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : `Ошибка ${res.status}`;
          throw new Error(message);
        }
        if (requestId === historyRequestId.current) setHistoryData(body as ReferralPointsResponse);
      } catch (err) {
        if (requestId === historyRequestId.current) setHistoryError(asErrorMessage(err));
      } finally {
        if (requestId === historyRequestId.current) setHistoryLoading(false);
      }
    },
    [token],
  );

  const loadSuccessfulPayments = useCallback(async (uuid: string) => {
    const requestId = ++paymentCountRequestId.current;
    setSuccessfulPayments({ loading: true, count: null, error: "" });
    try {
      const res = await fetch(`${apiBase}/admin/referrals/users/${encodeURIComponent(uuid)}/successful-payments`, {
        headers: { "X-Admin-Token": token.trim() },
        credentials: "include",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !Number.isInteger(body?.count) || body.count < 0) {
        const message = typeof body?.error === "string" ? body.error : `Ошибка ${res.status}`;
        throw new Error(message);
      }
      if (requestId === paymentCountRequestId.current) {
        setSuccessfulPayments({ loading: false, count: body.count, error: "" });
      }
    } catch (err) {
      if (requestId === paymentCountRequestId.current) {
        setSuccessfulPayments({ loading: false, count: null, error: asErrorMessage(err) });
      }
    }
  }, [token]);

  const openReferralHistory = useCallback(
    (uuid: string) => {
      setHistoryUuid(uuid);
      setHistoryData(null);
      setHistoryOpen(true);
      void loadUserEmail(uuid, true);
      void loadReferralHistory(uuid, 1);
      void loadSuccessfulPayments(uuid);
    },
    [loadReferralHistory, loadSuccessfulPayments, loadUserEmail],
  );

  const applyStatusUpdate = useCallback((uuid: string, status: ReferralUserStatus) => {
    setStatusOverrides((prev) => ({ ...prev, [uuid]: status }));
    setUserLookups((prev) => ({
      ...prev,
      [uuid]: { ...(prev[uuid] || { loading: false }), loading: false, status },
    }));
  }, []);

  const openDebitDialog = useCallback((uuid: string) => {
    setDebitUuid(uuid);
    setDebitAmount("");
    setDebitComment("");
    setDebitPointsBlocked(false);
    setDebitPenalized(false);
    setDebitError("");
    setDebitOpen(true);
    void loadUserEmail(uuid);
  }, [loadUserEmail]);

  const openPermissionDialog = useCallback((uuid: string, status?: ReferralUserStatus | null) => {
    setPermissionUuid(uuid);
    setPermissionComment(status?.exchangeAllowActive ? status.exchangeAllowComment || "" : "");
    setPermissionExpiresAt(
      status?.exchangeAllowActive ? toDateTimeLocalValue(status.exchangeAllowedUntil) : "",
    );
    setPermissionError("");
    setPermissionOpen(true);
  }, []);

  const submitExchangePermission = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const comment = permissionComment.trim();
      if (!comment) {
        setPermissionError("Укажите комментарий к разрешению обмена");
        return;
      }
      const expiresAt = new Date(permissionExpiresAt);
      if (!permissionExpiresAt || Number.isNaN(expiresAt.getTime())) {
        setPermissionError("Укажите дату и время окончания разрешения");
        return;
      }
      if (expiresAt.getTime() <= Date.now()) {
        setPermissionError("Дата окончания разрешения должна быть в будущем");
        return;
      }

      setPermissionLoading(true);
      setPermissionError("");
      try {
        const res = await fetch(
          `${apiBase}/admin/referrals/users/${encodeURIComponent(permissionUuid)}/exchange-permission`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Admin-Token": token.trim(),
            },
            credentials: "include",
            body: JSON.stringify({ comment, expiresAt: expiresAt.toISOString() }),
          },
        );
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : `Ошибка ${res.status}`;
          throw new Error(message);
        }
        const status = (body as { status?: ReferralUserStatus } | null)?.status;
        if (status) applyStatusUpdate(permissionUuid, status);
        toast.success(`Обмен разрешён до ${formatDate(expiresAt.toISOString())}`);
        setPermissionOpen(false);
      } catch (err) {
        setPermissionError(asErrorMessage(err));
      } finally {
        setPermissionLoading(false);
      }
    },
    [applyStatusUpdate, permissionComment, permissionExpiresAt, permissionUuid, token],
  );

  const revokeExchangePermission = useCallback(
    async (uuid: string) => {
      setRevokingUuid(uuid);
      try {
        const res = await fetch(
          `${apiBase}/admin/referrals/users/${encodeURIComponent(uuid)}/exchange-permission/revoke`,
          {
            method: "POST",
            headers: { "X-Admin-Token": token.trim() },
            credentials: "include",
          },
        );
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : `Ошибка ${res.status}`;
          throw new Error(message);
        }
        const status = (body as { status?: ReferralUserStatus } | null)?.status;
        if (status) applyStatusUpdate(uuid, status);
        toast.success("Разрешение на обмен отозвано");
      } catch (err) {
        toast.error(asErrorMessage(err));
      } finally {
        setRevokingUuid("");
      }
    },
    [applyStatusUpdate, token],
  );

  const submitDebitPoints = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const amountText = debitAmount.trim();
      const amount = Number(amountText);
      const comment = debitComment.trim();
      const statusOnly = !amountText && !comment;

      if (statusOnly && debitPenalized) {
        setDebitError("Для штрафа укажите количество баллов и причину списания");
        return;
      }
      if (!statusOnly && (!Number.isInteger(amount) || amount <= 0)) {
        setDebitError("Укажите положительное целое число баллов");
        return;
      }
      if (!statusOnly && !comment) {
        setDebitError("Укажите причину списания");
        return;
      }

      setDebitLoading(true);
      setDebitError("");
      try {
        const res = await fetch(`${apiBase}/admin/referrals/users/${encodeURIComponent(debitUuid)}/points/debit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Token": token.trim(),
          },
          credentials: "include",
          body: JSON.stringify(
            statusOnly
              ? { pointsBlocked: debitPointsBlocked }
              : { amount, comment, force: true, pointsBlocked: debitPointsBlocked, penalized: debitPenalized },
          ),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : `Ошибка ${res.status}`;
          throw new Error(message);
        }
        const data = body as DebitReferralPointsResponse;
        if (statusOnly) {
          toast.success(
            debitPointsBlocked
              ? "Начисление реферальных баллов заблокировано"
              : "Начисление реферальных баллов разблокировано",
          );
        } else {
          toast.success(`Списано ${amount} баллов. Новый баланс: ${data.balance ?? "—"}`);
        }
        if (typeof data.balance === "number") {
          setBalanceLookups((prev) => ({ ...prev, [debitUuid]: { loading: false, balance: data.balance } }));
        }
        if (data.status) {
          applyStatusUpdate(debitUuid, data.status);
        }
        setDebitOpen(false);
        if (!statusOnly && historyUuid === debitUuid) {
          void loadReferralHistory(debitUuid, historyData?.page || 1);
        }
      } catch (err) {
        setDebitError(asErrorMessage(err));
      } finally {
        setDebitLoading(false);
      }
    },
    [
      applyStatusUpdate,
      debitAmount,
      debitComment,
      debitPointsBlocked,
      debitPenalized,
      debitUuid,
      historyData?.page,
      historyUuid,
      loadReferralHistory,
      token,
    ],
  );

  const selectedUserLookup = historyUuid ? userLookups[historyUuid] : null;
  const selectedDebitLookup = debitUuid ? userLookups[debitUuid] : null;
  const selectedPermissionLookup = permissionUuid ? userLookups[permissionUuid] : null;

  return (
    <>
      {renderPage({ openHistory: openReferralHistory, openDebit: openDebitDialog })}
      {showReferrers ? (
      <section className="rounded-2xl bg-card p-4 ring-1 ring-border">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="mr-auto flex min-w-0 items-center gap-2">
            <AlertTriangle className="h-5 w-5 shrink-0 text-primary" />
            <h2 className="text-lg font-bold text-foreground">Рефереры с риском</h2>
          </div>
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void loadVisibleReferrerDetails()}
                  disabled={detailsLoading || items.length === 0 || !token.trim()}
                >
                  <RefreshCw className={cn("h-4 w-4", detailsLoading && "animate-spin")} aria-hidden="true" />
                  Update
                </button>
              </TooltipTrigger>
              <TooltipContent>Подгрузить email, баланс и email рефералов для текущих строк</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <div ref={filtersRef} className="relative">
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={filtersOpen}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-semibold text-foreground transition hover:bg-muted"
                    onClick={() => setFiltersOpen((open) => !open)}
                  >
                    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                    Фильтры
                  </button>
                </TooltipTrigger>
                <TooltipContent>Период, limit, риск, UUID и тип события</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {filtersOpen ? (
              <div
                role="dialog"
                aria-label="Фильтры рефереров с риском"
                className="absolute right-0 z-30 mt-2 w-[min(92vw,760px)] rounded-xl border border-border bg-card p-4 shadow-xl"
              >
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[150px_130px_150px_minmax(220px,1fr)_170px]">
                  {filtersPanel}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">По выбранным фильтрам ничего не найдено</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead colSpan={8} className="h-auto p-0">
                  <TooltipProvider delayDuration={150}>
                    <div className={cn(RISK_REFERRERS_GRID_CLASS, "px-3 py-3")}>
                      <span>Реферер</span>
                      <span>Email</span>
                      <span>Баллы</span>
                      <ColumnHeaderHint label="Score">
                        <p className="font-medium">Балл риска</p>
                        <p>
                          Итоговый уровень (критичный/высокий/средний) определяется по совпадению технических
                          отпечатков между событием и регистрацией:
                        </p>
                        <ul className="ml-3 list-disc space-y-0.5">
                          <li>критичный — совпали UA и FP</li>
                          <li>высокий — совпал IP вместе с UA или FP</li>
                          <li>средний — совпал только UA или только FP</li>
                          <li>совпал только IP или ничего — не фиксируем</li>
                        </ul>
                        <p>Очки за сигналы:</p>
                        <ul className="ml-3 list-disc space-y-0.5">
                          <li>совпадение отпечатков: критичный +100 / высокий +65 / средний +40</li>
                          <li>≥5 регистраций без единой оплаты: +70 (средний)</li>
                          <li>один IP/fingerprint часто при кодах/регистрациях: +55 (средний)</li>
                          <li>≥2 пропущенных реферальных начисления: +35 (средний)</li>
                          <li>5+ действий с одного браузера/устройства и 0 оплат: +30 (средний)</li>
                        </ul>
                        <p className="opacity-75">Если сигналов нет, но события есть — базовый балл 5.</p>
                      </ColumnHeaderHint>
                      <ColumnHeaderHint label="Воронка">
                        <p className="font-medium">Воронка переходов</p>
                        <p>
                          Формат <span className="font-mono">клики / коды / регистрации / оплаты</span>. Показывает, сколько пользователей
                          дошло до каждого шага: переход по ссылке → ввод кода → подтверждение (регистрация) → оплата (checkout).
                        </p>
                      </ColumnHeaderHint>
                      <ColumnHeaderHint label="Unique">
                        <p className="font-medium">Уникальные идентификаторы</p>
                        <p>
                          Число различных технических отпечатков среди рефералов: <span className="font-mono">IP</span> — уникальные хэши
                          IP-адресов, <span className="font-mono">UA</span> — уникальные хэши User-Agent, <span className="font-mono">FP</span>{" "}
                          — уникальные fingerprint-хэши.
                        </p>
                        <p className="opacity-75">Низкое разнообразие при большом числе рефералов — признак накрутки одним человеком.</p>
                      </ColumnHeaderHint>
                      <span>Warning-и</span>
                      <span>Last seen</span>
                    </div>
                  </TooltipProvider>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const visibleEvents =
                  eventType === "all" ? item.events : item.events.filter((event) => event.type === eventType);
                const itemStatus =
                  statusOverrides[item.referrerUuid] || userLookups[item.referrerUuid]?.status || item.status;
                const userLookup = userLookups[item.referrerUuid];
                const balanceLookup = balanceLookups[item.referrerUuid];
                return (
                  <TableRow key={item.referrerUuid}>
                    <TableCell colSpan={8} className="p-0">
                      <details
                        className="group"
                        onToggle={(event) => {
                          if (event.currentTarget.open) {
                            void loadUserEmail(item.referrerUuid);
                            void loadUserBalance(item.referrerUuid);
                            void loadReferredEmails(item);
                          }
                        }}
                      >
                        <summary
                          className={cn(
                            RISK_REFERRERS_GRID_CLASS,
                            "cursor-pointer list-none p-3 text-sm hover:bg-muted/50 [&::-webkit-details-marker]:hidden",
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2 text-foreground">
                            <ChevronRight
                              className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                              aria-hidden="true"
                            />
                            <CopyableText
                              value={item.referrerUuid}
                              label="UUID"
                              displayValue={shortenUuid(item.referrerUuid)}
                            />
                            <ReferralStatusBadges status={itemStatus} />
                          </span>
                          <span className="min-w-0 truncate text-xs text-muted-foreground">
                            {userLookup?.loading ? (
                              "загрузка..."
                            ) : userLookup?.email ? (
                              <CopyableText value={userLookup.email} label="Email" className="align-baseline" />
                            ) : (
                              userLookup?.error || "—"
                            )}
                          </span>
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {balanceLookup?.loading ? "загрузка..." : balanceLookup?.balance ?? balanceLookup?.error ?? "—"}
                          </span>
                          <span>
                            <ScoreBadge score={item.riskScore} level={item.riskLevel} />
                          </span>
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {item.counts.clicks}/{item.counts.codes}/{item.counts.verifies}/{item.counts.checkouts}
                          </span>
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            IP {item.unique.ipHashes} · UA {item.unique.userAgentHashes} · FP{" "}
                            {item.unique.fingerprintHashes}
                          </span>
                          <WarningList warnings={item.warnings} />
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {formatDate(item.lastSeen)}
                          </span>
                        </summary>
                        <div className="border-t border-border bg-muted/20 p-4">
                          <div className="mb-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-5">
                            <div className="min-w-0">
                              Email:{" "}
                              {userLookup?.loading ? (
                                "загрузка..."
                              ) : userLookup?.email ? (
                                <CopyableText
                                  value={userLookup.email}
                                  label="Email"
                                  className="align-baseline"
                                />
                              ) : (
                                userLookup?.error || "—"
                              )}
                            </div>
                            <div>
                              Баллы:{" "}
                              {balanceLookup?.loading
                                ? "загрузка..."
                                : balanceLookup?.balance ?? balanceLookup?.error ?? "—"}
                            </div>
                            <div>Email hashes: {item.unique.referredEmailHashes}</div>
                            <div>User prefixes: {item.unique.referredUuidPrefixes}</div>
                            <div>Credit skipped: {item.counts.creditSkipped}</div>
                          </div>
                          {hasReferralStatus(itemStatus) ? (
                            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <ReferralStatusBadges status={itemStatus} />
                              {itemStatus.penalizedAt ? <span>Штраф: {formatDate(itemStatus.penalizedAt)}</span> : null}
                              {itemStatus.pointsBlockedAt ? (
                                <span>Блокировка начислений: {formatDate(itemStatus.pointsBlockedAt)}</span>
                              ) : null}
                            </div>
                          ) : null}
                          {itemStatus?.exchangeAllowActive ? (
                            <div className="mb-3 space-y-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-foreground">
                              <p className="font-semibold">
                                Обмен разрешён до {formatDate(itemStatus.exchangeAllowedUntil)}
                              </p>
                              <p className="text-muted-foreground">
                                Комментарий: {itemStatus.exchangeAllowComment || "—"}
                              </p>
                              <p className="text-muted-foreground">
                                Выдано: {formatDate(itemStatus.exchangeAllowedAt)}
                              </p>
                            </div>
                          ) : null}
                          <div className="mb-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90"
                              onClick={() => openReferralHistory(item.referrerUuid)}
                            >
                              История
                            </button>
                            <button
                              type="button"
                              className="rounded-lg bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground transition hover:bg-destructive/90"
                              onClick={() => openDebitDialog(item.referrerUuid)}
                            >
                              Списать
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-500/20"
                              onClick={() => openPermissionDialog(item.referrerUuid, itemStatus)}
                            >
                              {itemStatus?.exchangeAllowActive ? "Продлить разрешение" : "Разрешить обмен"}
                            </button>
                            {itemStatus?.exchangeAllowActive ? (
                              <button
                                type="button"
                                className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={revokingUuid === item.referrerUuid}
                                onClick={() => void revokeExchangePermission(item.referrerUuid)}
                              >
                                {revokingUuid === item.referrerUuid ? "Отзываем..." : "Отозвать разрешение"}
                              </button>
                            ) : null}
                          </div>
                          <RiskWarningSpoilers
                            item={item}
                            referredEmailLookup={referredEmailLookups[item.referrerUuid]}
                          />
                          <OtherEventsSpoiler events={visibleEvents} />
                        </div>
                      </details>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
      ) : null}

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>История рефералов</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1">
                <p>
                  UUID:{" "}
                  {historyUuid ? (
                    <CopyableText value={historyUuid} label="UUID" displayValue={shortenUuid(historyUuid)} />
                  ) : (
                    "—"
                  )}
                </p>
                {selectedUserLookup?.email ? (
                  <p>
                    Email: <CopyableText value={selectedUserLookup.email} label="Email" />
                  </p>
                ) : null}
                <p>Тариф: {selectedUserLookup?.loading ? "Загрузка..." : selectedUserLookup?.subscription?.plan || "—"}</p>
                <p>Статус тарифа: {selectedUserLookup?.loading ? "Загрузка..." : formatSubscriptionStatus(selectedUserLookup?.subscription)}</p>
                <p>Дата окончания: {selectedUserLookup?.loading ? "Загрузка..." : formatDate(selectedUserLookup?.subscription?.expiresAt)}</p>
                <p>Успешных оплат: {successfulPayments.loading ? "Загрузка..." : successfulPayments.count ?? "—"}</p>
                {selectedUserLookup?.error ? (
                  <p role="alert">Не удалось загрузить тариф: {selectedUserLookup.error}</p>
                ) : null}
                {successfulPayments.error ? (
                  <p role="alert">Не удалось загрузить оплаты: {successfulPayments.error}</p>
                ) : null}
              </div>
            </DialogDescription>
          </DialogHeader>

          {historyLoading && !historyData ? (
            <p className="text-sm text-muted-foreground">Загрузка истории...</p>
          ) : historyError ? (
            <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{historyError}</p>
          ) : !historyData ? null : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                <Badge variant="secondary">Баланс: {historyData.balance ?? 0}</Badge>
                <Badge variant="secondary">Всего записей: {historyData.total ?? historyData.items.length}</Badge>
              </div>
              {historyData.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">История рефералов пустая</p>
              ) : (
              <TooltipProvider delayDuration={150}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Дата</TableHead>
                      <TableHead>Событие</TableHead>
                      <TableHead>Реферал</TableHead>
                      <TableHead className="w-[9rem] min-w-[9rem]">
                        <ColumnHeaderHint label="Сигналы">
                          <p className="font-medium">Совпадения UA / FP / IP</p>
                          <p>
                            Красный квадрат — отпечаток регистрации (User-Agent, fingerprint или IP) совпал с другой
                            регистрацией этого реферера либо с открытием ссылки из другого аккаунта. Чем больше
                            красных квадратов, тем больше условий совпало.
                          </p>
                          <p className="opacity-75">
                            «—» — по этой регистрации нет данных о событиях (истёк TTL в Redis).
                          </p>
                        </ColumnHeaderHint>
                      </TableHead>
                      <TableHead>Баллы</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {historyData.items.map((item, index) => (
                      <TableRow key={item.id || `${item.created_at}-${index}`}>
                        <TableCell className="whitespace-nowrap text-xs">{formatDate(item.created_at)}</TableCell>
                        <TableCell className="text-xs">{formatReferralPointReason(item)}</TableCell>
                        <TableCell className="text-xs">
                          {item.referred_user_email ? (
                            <CopyableText value={item.referred_user_email} label="Email" className="max-w-[220px]" />
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="w-[9rem] min-w-[9rem] whitespace-nowrap text-xs">
                          <RegistrationRiskCell item={item} />
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-xs font-bold",
                            item.amount >= 0 ? "text-emerald-600" : "text-destructive",
                          )}
                        >
                          {formatAmount(item.amount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TooltipProvider>
              )}
            </div>
          )}

          {historyData && historyData.total_pages > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                disabled={historyData.page <= 1 || historyLoading}
                onClick={() => void loadReferralHistory(historyUuid, historyData.page - 1)}
              >
                Назад
              </button>
              <span className="text-sm text-muted-foreground">
                Страница {historyData.page} из {historyData.total_pages}
              </span>
              <button
                type="button"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                disabled={historyData.page >= historyData.total_pages || historyLoading}
                onClick={() => void loadReferralHistory(historyUuid, historyData.page + 1)}
              >
                Вперёд
              </button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={debitOpen} onOpenChange={setDebitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Списать реферальные баллы</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1">
                <p>
                  UUID:{" "}
                  {debitUuid ? (
                    <CopyableText value={debitUuid} label="UUID" displayValue={shortenUuid(debitUuid)} />
                  ) : (
                    "—"
                  )}
                </p>
                {selectedDebitLookup?.email ? (
                  <p>
                    Email: <CopyableText value={selectedDebitLookup.email} label="Email" />
                  </p>
                ) : null}
              </div>
            </DialogDescription>
          </DialogHeader>

          <form className="space-y-4" onSubmit={submitDebitPoints}>
            <label className="block text-sm font-semibold text-foreground">
              Количество баллов
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={debitAmount}
                onChange={(event) => setDebitAmount(event.target.value)}
                placeholder="Например, 10"
                className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                disabled={debitLoading}
              />
            </label>
            <label className="block text-sm font-semibold text-foreground">
              Причина списания
              <Textarea
                value={debitComment}
                onChange={(event) => setDebitComment(event.target.value)}
                placeholder="Например: накрутка рефералов, ручная корректировка"
                disabled={debitLoading}
                className="mt-1"
              />
            </label>
            <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground">
              <Checkbox
                checked={debitPointsBlocked}
                onCheckedChange={(checked) => setDebitPointsBlocked(checked === true)}
                disabled={debitLoading}
                className="mt-0.5"
              />
              <span>
                <span className="block font-semibold">Заблокировать начисление реферальных баллов</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Пользователь будет помечен как заблокированный и больше не сможет получать баллы в
                  реферальной системе.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground">
              <Checkbox
                checked={debitPenalized}
                onCheckedChange={(checked) => setDebitPenalized(checked === true)}
                disabled={debitLoading}
                className="mt-0.5"
              />
              <span>
                <span className="block font-semibold">Штраф</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Отметить пользователя как оштрафованного. Если галочка снята, прежний штраф будет снят после списания.
                </span>
              </span>
            </label>
            {debitError ? (
              <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{debitError}</p>
            ) : null}
            <DialogFooter>
              <button
                type="button"
                className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                disabled={debitLoading}
                onClick={() => setDebitOpen(false)}
              >
                Отмена
              </button>
              <button
                type="submit"
                className="rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground transition hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={debitLoading}
              >
                {debitLoading ? "Списываем..." : "Списать"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={permissionOpen} onOpenChange={setPermissionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Разрешить обмен баллов</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1">
                <p>
                  UUID:{" "}
                  {permissionUuid ? (
                    <CopyableText value={permissionUuid} label="UUID" displayValue={shortenUuid(permissionUuid)} />
                  ) : (
                    "—"
                  )}
                </p>
                {selectedPermissionLookup?.email ? (
                  <p>
                    Email: <CopyableText value={selectedPermissionLookup.email} label="Email" />
                  </p>
                ) : null}
                <p>
                  Разрешение действует до указанного момента и обходит блокировку начислений и высокий риск
                  только для обмена. Начисление реферальных баллов остаётся заблокированным.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>

          <form className="space-y-4" onSubmit={submitExchangePermission}>
            <label className="block text-sm font-semibold text-foreground">
              Комментарий
              <Textarea
                value={permissionComment}
                onChange={(event) => setPermissionComment(event.target.value)}
                placeholder="Например: разбор обращения в поддержку, обмен согласован"
                disabled={permissionLoading}
                className="mt-1"
                required
              />
            </label>
            <label className="block text-sm font-semibold text-foreground">
              Действует до
              <input
                type="datetime-local"
                value={permissionExpiresAt}
                onChange={(event) => setPermissionExpiresAt(event.target.value)}
                className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                disabled={permissionLoading}
                required
              />
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                Время указывается в вашем часовом поясе и сохраняется в UTC.
              </span>
            </label>
            {permissionError ? (
              <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{permissionError}</p>
            ) : null}
            <DialogFooter>
              <button
                type="button"
                className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                disabled={permissionLoading}
                onClick={() => setPermissionOpen(false)}
              >
                Отмена
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={permissionLoading}
              >
                {permissionLoading ? "Сохраняем..." : "Разрешить обмен"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function AdminReferrals() {
  const [token, setToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "");
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState<"7" | "30" | "all">("30");
  const [limit, setLimit] = useState("5000");
  const [riskFilter, setRiskFilter] = useState<RiskLevel | "all">("all");
  const [eventType, setEventType] = useState("all");
  const [referrerFilter, setReferrerFilter] = useState("");
  const [exchangeRequests, setExchangeRequests] = useState<ReferralExchangeRequest[]>([]);
  const [exchangeRequestsLoading, setExchangeRequestsLoading] = useState(false);
  const [exchangeRequestsError, setExchangeRequestsError] = useState("");
  const [exchangeActionId, setExchangeActionId] = useState("");
  const [exchangeComments, setExchangeComments] = useState<Record<string, string>>({});
  const [exchangeApprovalRequest, setExchangeApprovalRequest] = useState<ReferralExchangeRequest | null>(null);
  const [exchangeRejectionRequest, setExchangeRejectionRequest] = useState<ReferralExchangeRequest | null>(null);
  const [exchangeApprovalForce, setExchangeApprovalForce] = useState(false);
  const [exchangeApprovalError, setExchangeApprovalError] = useState("");
  const [exchangeRejectionError, setExchangeRejectionError] = useState("");
  const exchangeActionInFlight = useRef(false);
  const didAutoLoad = useRef(false);

  const loadExchangeRequests = useCallback(async (adminToken = token.trim()) => {
    const trimmedToken = adminToken.trim();
    if (!trimmedToken) return;
    setExchangeRequestsLoading(true);
    setExchangeRequestsError("");
    try {
      const res = await fetch(`${apiBase}/admin/referrals/exchange-requests?status=pending`, {
        headers: { "X-Admin-Token": trimmedToken },
        credentials: "include",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : `Ошибка ${res.status}`;
        throw new Error(message);
      }
      const data = body as ReferralExchangeRequestsResponse;
      setExchangeRequests(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setExchangeRequestsError(asErrorMessage(err));
    } finally {
      setExchangeRequestsLoading(false);
    }
  }, [token]);

  const load = useCallback(async () => {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      setError("Введите ADMIN_REDIS_TOKEN");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({
        days: period,
        limit: String(Math.max(1, Math.min(20000, Number(limit) || 5000))),
      });
      const res = await fetch(`${apiBase}/admin/referrals/summary?${qs}`, {
        headers: { "X-Admin-Token": trimmedToken },
        credentials: "include",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : `Ошибка ${res.status}`;
        throw new Error(message);
      }
      setSummary(body as ReferralSummary);
      localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, trimmedToken);
      void loadExchangeRequests(trimmedToken);
    } catch (err) {
      setError(asErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [limit, loadExchangeRequests, period, token]);

  const processExchangeRequest = useCallback(
    async (requestId: string, action: "approve" | "reject", force = false) => {
      if (exchangeActionInFlight.current) return;
      const trimmedToken = token.trim();
      if (!trimmedToken) {
        if (action === "approve") setExchangeApprovalError("Введите ADMIN_REDIS_TOKEN");
        else setExchangeRejectionError("Введите ADMIN_REDIS_TOKEN");
        return;
      }
      exchangeActionInFlight.current = true;
      setExchangeActionId(requestId);
      setExchangeRequestsError("");
      if (action === "approve") setExchangeApprovalError("");
      else setExchangeRejectionError("");
      try {
        const typedComment = (exchangeComments[requestId] || "").trim();
        const comment =
          typedComment || (action === "approve" ? DEFAULT_EXCHANGE_APPROVE_COMMENT : DEFAULT_EXCHANGE_REJECT_COMMENT);
        const res = await fetch(`${apiBase}/admin/referrals/exchange-requests/${encodeURIComponent(requestId)}/${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Token": trimmedToken,
          },
          credentials: "include",
          body: JSON.stringify(action === "approve" ? { comment, force } : { comment }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : `Ошибка ${res.status}`;
          throw new Error(message);
        }
        const data = body as ReferralExchangeActionResponse;
        if (action === "approve") {
          toast.success(`Заявка одобрена. Баланс: ${data.exchange?.balance ?? data.debit?.balance ?? "—"}`);
          setExchangeApprovalRequest(null);
        } else {
          toast.success("Заявка отклонена");
          setExchangeRejectionRequest(null);
        }
        setExchangeComments((prev) => {
          const next = { ...prev };
          delete next[requestId];
          return next;
        });
        await loadExchangeRequests(trimmedToken);
      } catch (err) {
        if (action === "approve") setExchangeApprovalError(asErrorMessage(err));
        else setExchangeRejectionError(asErrorMessage(err));
      } finally {
        exchangeActionInFlight.current = false;
        setExchangeActionId("");
      }
    },
    [exchangeComments, loadExchangeRequests, token],
  );

  useEffect(() => {
    if (didAutoLoad.current) return;
    didAutoLoad.current = true;
    if (token) void load();
  }, [load, token]);

  const filteredReferrers = useMemo(() => {
    if (!summary) return [];
    const refNeedle = referrerFilter.trim().toLowerCase();
    return summary.referrers.filter((item) => {
      if (riskFilter !== "all" && item.riskLevel !== riskFilter) return false;
      if (refNeedle && !item.referrerUuid.toLowerCase().includes(refNeedle)) return false;
      if (eventType !== "all" && !item.events.some((event) => event.type === eventType)) return false;
      return true;
    });
  }, [eventType, referrerFilter, riskFilter, summary]);

  const referrerFiltersPanel = (
    <>
      <label className="text-sm font-semibold text-foreground">
        Период
        <select
          value={period}
          onChange={(event) => setPeriod(event.target.value as "7" | "30" | "all")}
          className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="7">7 дней</option>
          <option value="30">30 дней</option>
          <option value="all">Весь Redis TTL</option>
        </select>
      </label>
      <label className="text-sm font-semibold text-foreground">
        Limit
        <input
          type="number"
          min="1"
          max="20000"
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
          className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="text-sm font-semibold text-foreground">
        Риск
        <select
          value={riskFilter}
          onChange={(event) => setRiskFilter(event.target.value as RiskLevel | "all")}
          className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">Все уровни</option>
          <option value="critical">Критичный</option>
          <option value="high">Высокий</option>
          <option value="medium">Средний</option>
          <option value="low">Низкий</option>
          <option value="none">Нет</option>
        </select>
      </label>
      <label className="text-sm font-semibold text-foreground">
        Referrer UUID
        <input
          value={referrerFilter}
          onChange={(event) => setReferrerFilter(event.target.value)}
          placeholder="Фильтр по UUID"
          className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="text-sm font-semibold text-foreground">
        Тип события
        <select
          value={eventType}
          onChange={(event) => setEventType(event.target.value)}
          className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          {EVENT_FILTERS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );

  return (
    <AdminPageShell
      eyebrow="Referral Risk Monitor"
      title="Реферальная статистика из Redis"
      description="Воронка, top hashes и backend warning-и по подозрению на накрутку."
      icon={GitBranch}
      token={token}
      onTokenChange={setToken}
      onReset={() => {
        setSummary(null);
        setExchangeRequests([]);
        setExchangeRequestsError("");
        setExchangeActionId("");
        setExchangeComments({});
        setExchangeApprovalRequest(null);
        setExchangeRejectionRequest(null);
        setExchangeApprovalForce(false);
        setExchangeApprovalError("");
        setExchangeRejectionError("");
        setError("");
      }}
      onRefresh={load}
      loading={loading}
      error={error}
      updatedAt={summary?.generatedAt}
    >
      <ReferralUserWorkspace
        key={token}
        items={filteredReferrers}
        eventType={eventType}
        token={token}
        filtersPanel={referrerFiltersPanel}
        showReferrers={Boolean(summary)}
        renderPage={({ openHistory, openDebit }) => (
          <>
      <section className="rounded-2xl bg-card p-4 ring-1 ring-border">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h2 className="text-lg font-bold text-foreground">Активные заявки на обмен</h2>
            <p className="text-sm text-muted-foreground">
              Операторы вручную выдают дни или призы, затем одобряют заявку для списания баллов.
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void loadExchangeRequests()}
            disabled={exchangeRequestsLoading || !token.trim()}
          >
            {exchangeRequestsLoading ? "Обновляем..." : "Обновить"}
          </button>
        </div>
        {exchangeRequestsError ? (
          <p className="mb-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{exchangeRequestsError}</p>
        ) : null}
        {exchangeRequestsLoading && exchangeRequests.length === 0 ? (
          <p className="text-sm text-muted-foreground">Загрузка заявок...</p>
        ) : exchangeRequests.length === 0 ? (
          <p className="text-sm text-muted-foreground">Активных заявок нет</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Создана</TableHead>
                  <TableHead>Пользователь</TableHead>
                  <TableHead>Заявка</TableHead>
                  <TableHead>Детали</TableHead>
                  <TableHead>Баллы</TableHead>
                  <TableHead>Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exchangeRequests.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell className="whitespace-nowrap text-xs">{formatDate(request.createdAt)}</TableCell>
                    <TableCell className="text-xs">
                      <div className="flex flex-col items-start gap-1">
                        <CopyableText value={request.referrerUuid} label="UUID" displayValue={shortenUuid(request.referrerUuid)} />
                        {request.email ? <CopyableText value={request.email} label="Email" className="max-w-[220px]" /> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs font-semibold">{formatExchangeRequestKind(request)}</TableCell>
                    <TableCell className="max-w-[280px] whitespace-pre-wrap text-xs text-muted-foreground">
                      {formatExchangeRequestDetails(request)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs font-bold">{request.points}</TableCell>
                    <TableCell className="min-w-[248px]">
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-muted"
                          onClick={() => openHistory(request.referrerUuid)}
                        >
                          История
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={Boolean(exchangeActionId)}
                          onClick={() => {
                            setExchangeRejectionRequest(request);
                            setExchangeRejectionError("");
                          }}
                        >
                          Отклонить
                        </button>
                        <button
                          type="button"
                          className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={Boolean(exchangeActionId)}
                          onClick={() => {
                            setExchangeApprovalRequest(request);
                            setExchangeApprovalForce(false);
                            setExchangeApprovalError("");
                          }}
                        >
                          {exchangeActionId === request.id ? "..." : "Одобрить"}
                        </button>
                        <button
                          type="button"
                          className="rounded-lg bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground transition hover:bg-destructive/90"
                          onClick={() => openDebit(request.referrerUuid)}
                        >
                          Списать
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <Dialog
        open={Boolean(exchangeApprovalRequest)}
        onOpenChange={(open) => {
          if (!open && !exchangeActionInFlight.current) setExchangeApprovalRequest(null);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (exchangeActionInFlight.current) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (exchangeActionInFlight.current) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Одобрить заявку на обмен?</DialogTitle>
            <DialogDescription>Подтвердите выдачу и списание баллов по заявке.</DialogDescription>
          </DialogHeader>
          {exchangeApprovalRequest ? (
            <div className="space-y-3 text-sm text-foreground">
              <div>
                <p>Пользователь: {exchangeApprovalRequest.email || "—"}</p>
                <p className="break-all text-xs text-muted-foreground">UUID: {exchangeApprovalRequest.referrerUuid}</p>
              </div>
              <p>Обмен: {formatExchangeRequestKind(exchangeApprovalRequest)}</p>
              <p className="whitespace-pre-wrap text-muted-foreground">{formatExchangeRequestDetails(exchangeApprovalRequest)}</p>
              <p>К списанию: <strong>{exchangeApprovalRequest.points}</strong> баллов</p>
              <label className="block font-semibold">
                Комментарий
                <Textarea
                  value={exchangeComments[exchangeApprovalRequest.id] || ""}
                  onChange={(event) => setExchangeComments((prev) => ({ ...prev, [exchangeApprovalRequest.id]: event.target.value }))}
                  placeholder="Комментарий оператора"
                  disabled={exchangeActionId === exchangeApprovalRequest.id}
                  className="mt-1 font-normal"
                />
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
                <Checkbox
                  checked={exchangeApprovalForce}
                  onCheckedChange={(checked) => setExchangeApprovalForce(checked === true)}
                  disabled={exchangeActionId === exchangeApprovalRequest.id}
                  className="mt-0.5"
                />
                <span>Списать баллы, даже если тариф не активен</span>
              </label>
              {exchangeApprovalError ? (
                <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                  {exchangeApprovalError}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(exchangeActionId)}
              onClick={() => setExchangeApprovalRequest(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(exchangeActionId) || !exchangeApprovalRequest}
              onClick={() => {
                if (exchangeApprovalRequest) {
                  void processExchangeRequest(exchangeApprovalRequest.id, "approve", exchangeApprovalForce);
                }
              }}
            >
              {exchangeActionId === exchangeApprovalRequest?.id ? "Одобряем..." : "Одобрить и списать баллы"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(exchangeRejectionRequest)}
        onOpenChange={(open) => {
          if (!open && !exchangeActionInFlight.current) setExchangeRejectionRequest(null);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (exchangeActionInFlight.current) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (exchangeActionInFlight.current) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Отклонить заявку на обмен?</DialogTitle>
            <DialogDescription>Подтвердите отклонение заявки.</DialogDescription>
          </DialogHeader>
          {exchangeRejectionRequest ? (
            <div className="space-y-3 text-sm text-foreground">
              <div>
                <p>Пользователь: {exchangeRejectionRequest.email || "—"}</p>
                <p className="break-all text-xs text-muted-foreground">UUID: {exchangeRejectionRequest.referrerUuid}</p>
              </div>
              <p>Обмен: {formatExchangeRequestKind(exchangeRejectionRequest)}</p>
              <p className="whitespace-pre-wrap text-muted-foreground">{formatExchangeRequestDetails(exchangeRejectionRequest)}</p>
              <p>Баллы по заявке: <strong>{exchangeRejectionRequest.points}</strong></p>
              <label className="block font-semibold">
                Комментарий
                <Textarea
                  value={exchangeComments[exchangeRejectionRequest.id] || ""}
                  onChange={(event) => setExchangeComments((prev) => ({ ...prev, [exchangeRejectionRequest.id]: event.target.value }))}
                  placeholder="Комментарий оператора"
                  disabled={exchangeActionId === exchangeRejectionRequest.id}
                  className="mt-1 font-normal"
                />
              </label>
              {exchangeRejectionError ? (
                <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                  {exchangeRejectionError}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(exchangeActionId)}
              onClick={() => setExchangeRejectionRequest(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground transition hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(exchangeActionId) || !exchangeRejectionRequest}
              onClick={() => {
                if (exchangeRejectionRequest) void processExchangeRequest(exchangeRejectionRequest.id, "reject");
              }}
            >
              {exchangeActionId === exchangeRejectionRequest?.id ? "Отклоняем..." : "Отклонить заявку"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {summary && (
        <>
          <section className="rounded-2xl bg-card p-4 ring-1 ring-border">
            <TooltipProvider delayDuration={150}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="mr-auto text-lg font-bold text-foreground">Воронка и риск</h2>
                {(Object.keys(RISK_LABELS) as RiskLevel[]).map((level) => (
                  <Badge key={level} className={cn("border", riskClass(level))}>
                    {RISK_LABELS[level]}: {summary.riskSummary[level] || 0}
                  </Badge>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                {(Object.keys(RISK_TOTAL_HINTS) as Array<keyof ReferralSummary["totals"]>).map((key) => {
                  const item = RISK_TOTAL_HINTS[key];
                  return (
                    <StatCard
                      key={key}
                      label={item.label}
                      value={summary.totals[key]}
                      description={item.description}
                    />
                  );
                })}
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {(Object.keys(RISK_FUNNEL_HINTS) as Array<keyof ReferralCounts>).map((key) => {
                  const item = RISK_FUNNEL_HINTS[key];
                  return (
                    <StatCard
                      key={key}
                      label={item.label}
                      value={summary.funnel[key]}
                      description={item.description}
                    />
                  );
                })}
              </div>
            </TooltipProvider>
          </section>

          <DailyRegistrationsChart data={summary.dailyRegistrations || []} />

        </>
      )}
          </>
        )}
      />
    </AdminPageShell>
  );
}
