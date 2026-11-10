// /admin/funnel: per-day funnel counters (api/funnel.mjs). Uses the same admin token as /admin/redis.
// The same file is copied unchanged into every brand site.
import { useCallback, useEffect, useState } from "react";

const TOKEN_STORAGE_KEY = "admin_redis_token";

type Row = { day: string; events: Record<string, { count: number; visitors: number }> };

const LABELS: Record<string, string> = {
  landing_view: "Открыли лендинг",
  landing_cta: "Кнопка на лендинге",
  login_open: "Открыли вход",
  code_sent: "Код отправлен",
  login_ok: "Вошли",
  dashboard_view: "Открыли кабинет",
  instructions_open: "Открыли инструкцию",
  install_click: "Нажали «установить»",
  add_click: "Нажали «добавить подписку»",
  copy_link: "Скопировали ссылку",
  qr_open: "Открыли QR",
  device_connected: "В кабинете с устройством",
  buy_open: "Открыли тарифы",
  checkout_click: "Выбрали оплату",
  checkout_created: "Счёт создан",
  pay_success_view: "Страница «оплачено»",
  pay_fail_view: "Страница «не оплачено»",
  support_open: "Открыли поддержку",
};

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

const AdminFunnel = () => {
  const [token, setToken] = useState(readToken);
  const [days, setDays] = useState(14);
  const [events, setEvents] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<"visitors" | "count">("visitors");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!token.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/funnel?days=${days}`, { headers: { "X-Admin-Token": token.trim() } });
      if (!res.ok) throw new Error(res.status === 401 ? "Неверный токен" : `Ошибка ${res.status}`);
      const data = await res.json();
      setEvents(data.events || []);
      setRows(data.days || []);
      try {
        localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
      } catch {
        // The token is just not remembered.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить");
    } finally {
      setLoading(false);
    }
  }, [token, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = (event: string) => rows.reduce((sum, r) => sum + (r.events[event]?.[mode] ?? 0), 0);

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", color: "#0f172a", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, margin: "8px 0 16px" }}>Воронка сайта</h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          <input
            type="password"
            placeholder="Админ-токен"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ flex: "1 1 220px", padding: 8, border: "1px solid #cbd5e1", borderRadius: 8 }}
          />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ padding: 8, borderRadius: 8 }}>
            {[7, 14, 30, 60].map((d) => (
              <option key={d} value={d}>
                {d} дней
              </option>
            ))}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value as "visitors" | "count")} style={{ padding: 8, borderRadius: 8 }}>
            <option value="visitors">Посетители</option>
            <option value="count">События</option>
          </select>
          <button type="button" onClick={() => void load()} disabled={loading} style={{ padding: "8px 16px", borderRadius: 8 }}>
            {loading ? "Загрузка…" : "Обновить"}
          </button>
        </div>
        {error && <p style={{ color: "#dc2626" }}>{error}</p>}
        {mode === "visitors" && (
          <p style={{ fontSize: 13, color: "#64748b", marginTop: 0 }}>
            Посетители считаются по случайному идентификатору браузера, приблизительно. Шаги входа и счёта считаются на сервере, только как события.
          </p>
        )}
        {rows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 13, whiteSpace: "nowrap" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: 6, position: "sticky", left: 0, background: "#f8fafc" }}>Шаг</th>
                  <th style={{ padding: 6 }}>Всего</th>
                  {rows.map((r) => (
                    <th key={r.day} style={{ padding: 6 }}>
                      {r.day.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event} style={{ borderTop: "1px solid #e2e8f0" }}>
                    <td style={{ padding: 6, position: "sticky", left: 0, background: "#f8fafc" }}>{LABELS[event] || event}</td>
                    <td style={{ padding: 6, textAlign: "right", fontWeight: 600 }}>{total(event)}</td>
                    {rows.map((r) => (
                      <td key={r.day} style={{ padding: 6, textAlign: "right" }}>
                        {r.events[event]?.[mode] ?? 0}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminFunnel;
