import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Database } from "lucide-react";
import { apiBase } from "@/lib/api";
import { formatUserError } from "@/lib/errorMessages";
import { ADMIN_TOKEN_STORAGE_KEY } from "@/lib/admin";
import AdminPageShell from "@/components/AdminPageShell";

type CounterEntry = { key: string; count: number };

type ExpiringEntry = {
  key: string;
  ttlSec: number;
  expiresAt: string | null;
};

type OtpEntry = ExpiringEntry & {
  emailMasked: string;
  emailHash: string;
  tries: number;
};

type CooldownEntry = ExpiringEntry & {
  emailMasked: string;
  emailHash: string;
};

type SessionEntry = ExpiringEntry & {
  emailMasked: string;
  emailHash: string;
  userUuidPrefix: string;
  expAt: string | null;
};

type RateLimitEntry = ExpiringEntry & {
  subject: string;
  count: number;
};

type AuthEvent = {
  id?: string;
  type?: string;
  at?: string;
  ip?: string;
  userAgent?: string;
  emailMasked?: string;
  emailHash?: string;
  userUuidPrefix?: string;
  status?: string;
  detail?: string;
};

type DailyAuthDay = {
  date: string;
  sent: number;
  unfinished: number;
  noCodeSubmitted: number;
  codeNotAccepted: number;
  preliminary: boolean;
  partial: boolean;
};

type RedisAuthSnapshot = {
  generatedAt: string;
  totals: {
    otp: number;
    cooldowns: number;
    sessions: number;
    rateLimits: number;
    events: number;
  };
  otp: OtpEntry[];
  cooldowns: CooldownEntry[];
  sessions: SessionEntry[];
  rateLimits: {
    sendCodeIp: RateLimitEntry[];
    sendCodeEmail: RateLimitEntry[];
    verifyIp: RateLimitEntry[];
    checkoutSession: RateLimitEntry[];
  };
  stats: {
    byType: CounterEntry[];
    byIp: CounterEntry[];
    byEmailHash: CounterEntry[];
  };
  events: AuthEvent[];
  dailyAuth: {
    timeZone: string;
    startedAt: string | null;
    today: string;
    days: DailyAuthDay[];
  };
};

const AUTO_OPEN_ITEM_LIMIT = 5;

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU");
}

function formatTtl(ttlSec: number) {
  if (ttlSec < 0) return "без TTL";
  if (ttlSec < 60) return `${ttlSec} сек`;
  const minutes = Math.floor(ttlSec / 60);
  const seconds = ttlSec % 60;
  if (minutes < 60) return `${minutes} мин ${seconds} сек`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

function asErrorMessage(error: unknown) {
  return formatUserError(error, "Не удалось загрузить данные");
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-border">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-bold text-foreground">{value}</p>
    </div>
  );
}

function DailyAuthStats({ data }: { data: RedisAuthSnapshot["dailyAuth"] }) {
  const today = data.days[0]?.date === data.today ? data.days[0] : null;
  return (
    <section className="rounded-2xl bg-card p-4 ring-1 ring-border">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-foreground">Незавершённая авторизация</h2>
        <p className="text-sm text-muted-foreground">
          Уникальные email по календарным дням Москвы. Сегодняшние числа предварительные.
        </p>
      </div>
      {!data.startedAt ? (
        <p className="text-sm text-muted-foreground">Нет данных. Сбор начнётся с первого события авторизации.</p>
      ) : (
        <>
          {today && (
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Запросили код сегодня" value={today.sent} />
              <StatCard label="Не завершили ввод" value={today.unfinished} />
              <StatCard label="Не отправили код на проверку" value={today.noCodeSubmitted} />
              <StatCard label="Отправили, но код не принят" value={today.codeNotAccepted} />
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[650px] text-left text-sm">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2">День (МСК)</th>
                  <th scope="col" className="px-3 py-2 text-right">Запросили код</th>
                  <th scope="col" className="px-3 py-2 text-right">Не завершили ввод</th>
                  <th scope="col" className="px-3 py-2 text-right">Не отправили код на проверку</th>
                  <th scope="col" className="px-3 py-2 text-right">Код не принят</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((day) => (
                  <tr key={day.date} className="border-b border-border last:border-0">
                    <th scope="row" className="whitespace-nowrap px-3 py-2 font-medium text-foreground">
                      {day.date}
                      {day.preliminary && <span className="ml-2 text-xs text-muted-foreground">предварительно</span>}
                      {day.partial && <span className="ml-2 text-xs text-muted-foreground">неполный день</span>}
                    </th>
                    <td className="px-3 py-2 text-right">{day.sent}</td>
                    <td className="px-3 py-2 text-right font-semibold">{day.unfinished}</td>
                    <td className="px-3 py-2 text-right">{day.noCodeSubmitted}</td>
                    <td className="px-3 py-2 text-right">{day.codeNotAccepted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function SpoilerSection({
  title,
  count,
  emptyMessage,
  children,
}: {
  title: string;
  count: number;
  emptyMessage: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(count <= AUTO_OPEN_ITEM_LIMIT);

  useEffect(() => {
    setOpen(count <= AUTO_OPEN_ITEM_LIMIT);
  }, [count]);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-2xl bg-card p-4 ring-1 ring-border"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-lg font-bold text-foreground [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <strong className="rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary">{count}</strong>
      </summary>

      {open && (
        <div className="mt-3">
          {count === 0 ? <p className="text-sm text-muted-foreground">{emptyMessage}</p> : children}
        </div>
      )}
    </details>
  );
}

function CounterList({ title, items }: { title: string; items: CounterEntry[] }) {
  return (
    <SpoilerSection title={title} count={items.length} emptyMessage="Нет данных">
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.key} className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2">
            <span className="min-w-0 truncate font-mono text-xs text-foreground">{item.key}</span>
            <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-bold text-primary">{item.count}</span>
          </div>
        ))}
      </div>
    </SpoilerSection>
  );
}

function RateLimitList({ title, items }: { title: string; items: RateLimitEntry[] }) {
  return (
    <SpoilerSection title={title} count={items.length} emptyMessage="Нет активных ключей">
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.key} className="rounded-lg bg-muted p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 truncate font-mono text-xs text-foreground">{item.subject}</p>
              <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-bold text-primary">
                {item.count}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              TTL: {formatTtl(item.ttlSec)} · до {formatDate(item.expiresAt)}
            </p>
          </div>
        ))}
      </div>
    </SpoilerSection>
  );
}

function OtpList({ items }: { items: OtpEntry[] }) {
  return (
    <SpoilerSection title="Активные OTP" count={items.length} emptyMessage="Нет активных кодов">
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.key} className="rounded-lg bg-muted p-3">
            <p className="font-semibold text-foreground">{item.emailMasked || item.emailHash}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Попытки: {item.tries} · TTL: {formatTtl(item.ttlSec)} · hash: {item.emailHash}
            </p>
          </div>
        ))}
      </div>
    </SpoilerSection>
  );
}

function CooldownList({ items }: { items: CooldownEntry[] }) {
  return (
    <SpoilerSection title="Cooldown отправки" count={items.length} emptyMessage="Нет активных cooldown">
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.key} className="rounded-lg bg-muted p-3">
            <p className="font-semibold text-foreground">{item.emailMasked || item.emailHash}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              TTL: {formatTtl(item.ttlSec)} · до {formatDate(item.expiresAt)}
            </p>
          </div>
        ))}
      </div>
    </SpoilerSection>
  );
}

function SessionList({ items }: { items: SessionEntry[] }) {
  return (
    <SpoilerSection title="Сессии" count={items.length} emptyMessage="Нет активных сессий">
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.key} className="rounded-lg bg-muted p-3">
            <p className="font-semibold text-foreground">{item.emailMasked || item.emailHash || "Без email"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              user: {item.userUuidPrefix || "—"} · TTL: {formatTtl(item.ttlSec)} · session exp:{" "}
              {formatDate(item.expAt)}
            </p>
          </div>
        ))}
      </div>
    </SpoilerSection>
  );
}

function EventList({ items }: { items: AuthEvent[] }) {
  return (
    <SpoilerSection title="Последние события" count={items.length} emptyMessage="Событий пока нет">
      <div className="space-y-2">
        {items.map((item, index) => (
          <div key={item.id || `${item.at}-${index}`} className="rounded-lg bg-muted p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-mono text-xs font-bold text-foreground">{item.type || "event"}</p>
              <span className="text-xs text-muted-foreground">{formatDate(item.at)}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              IP: {item.ip || "—"} · email: {item.emailMasked || item.emailHash || "—"} · status:{" "}
              {item.status || "—"}
            </p>
            {item.userAgent && <p className="mt-1 truncate text-xs text-muted-foreground">{item.userAgent}</p>}
          </div>
        ))}
      </div>
    </SpoilerSection>
  );
}

export default function AdminRedis() {
  const [token, setToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "");
  const [snapshot, setSnapshot] = useState<RedisAuthSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const didAutoLoad = useRef(false);

  const allRateLimitGroups = useMemo(() => {
    if (!snapshot) return [];
    return [
      { title: "Rate limit: отправка кода по IP", items: snapshot.rateLimits.sendCodeIp },
      { title: "Rate limit: отправка кода по email", items: snapshot.rateLimits.sendCodeEmail },
      { title: "Rate limit: проверка кода по IP", items: snapshot.rateLimits.verifyIp },
      { title: "Rate limit: checkout по session/IP", items: snapshot.rateLimits.checkoutSession },
    ];
  }, [snapshot]);

  const load = useCallback(async () => {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      setError("Введите ADMIN_REDIS_TOKEN");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${apiBase}/admin/redis-auth`, {
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
      setSnapshot(body as RedisAuthSnapshot);
      localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, trimmedToken);
    } catch (err) {
      setError(asErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (didAutoLoad.current) return;
    didAutoLoad.current = true;
    if (token) void load();
  }, [load, token]);

  return (
    <AdminPageShell
      eyebrow="Redis Auth Monitor"
      title="Данные авторизации из Redis"
      description="OTP, cooldown, сессии, rate-limit ключи, IP и последние попытки входа."
      icon={Database}
      token={token}
      onTokenChange={setToken}
      onReset={() => {
        setSnapshot(null);
        setError("");
      }}
      onRefresh={load}
      loading={loading}
      error={error}
      updatedAt={snapshot?.generatedAt}
    >
        {snapshot && (
          <>
            <DailyAuthStats data={snapshot.dailyAuth} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard label="OTP" value={snapshot.totals.otp} />
              <StatCard label="Cooldown" value={snapshot.totals.cooldowns} />
              <StatCard label="Сессии" value={snapshot.totals.sessions} />
              <StatCard label="Rate limits" value={snapshot.totals.rateLimits} />
              <StatCard label="События" value={snapshot.totals.events} />
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <CounterList title="Статистика по событиям" items={snapshot.stats.byType} />
              <CounterList title="Top IP" items={snapshot.stats.byIp} />
              <CounterList title="Top email hash" items={snapshot.stats.byEmailHash} />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <OtpList items={snapshot.otp} />
              <CooldownList items={snapshot.cooldowns} />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <SessionList items={snapshot.sessions} />
              <EventList items={snapshot.events} />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              {allRateLimitGroups.map((group) => (
                <RateLimitList key={group.title} title={group.title} items={group.items} />
              ))}
            </div>

            <div className="rounded-2xl bg-card p-4 text-sm text-muted-foreground ring-1 ring-border">
              <Activity className="mr-2 inline h-4 w-4 text-primary" />
              Страница показывает только безопасный snapshot: OTP-коды и session/CSRF значения не выводятся.
            </div>
          </>
        )}
    </AdminPageShell>
  );
}
