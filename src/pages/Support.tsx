import { useEffect, useState } from "react";
import { apiBase } from "@/lib/api";
import DashboardSidebar from "@/components/DashboardSidebar";
import { useDashboardSidebarItems } from "@/hooks/useDashboardSidebarItems";
import LandingShell from "@/pages/landing/LandingShell";
import LandingFooter from "@/pages/landing/LandingFooter";

const Support = () => {
  const { email, items, handleLogout } = useDashboardSidebarItems();
  const [announcement, setAnnouncement] = useState<string | null>(null);

  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    fetch(`${apiBase}/announcement`)
      .then((r) => r.json() as Promise<{ text?: unknown }>)
      .then((data) => {
        if (cancelled) return;
        if (typeof data?.text === "string" && data.text.trim()) setAnnouncement(data.text.trim());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [email]);

  return (
    <LandingShell className="landing-root--with-sidebar">
      <DashboardSidebar items={items} onLogout={handleLogout} email={email || undefined} />

      <main>
        <section className="app-page">
          <div className="container">
            {announcement ? (
              <section
                className="support-card support-announcement support-announcement--page-start"
                role="status"
                aria-label="Важное объявление"
              >
                <h2 className="support-card__title">Важное объявление</h2>
                <p className="support-card__subtitle whitespace-pre-wrap">{announcement}</p>
              </section>
            ) : null}

            <div className="app-page__eyebrow">Поддержка 220v</div>
            <h1 className="app-page__title">Поможем подключиться, настроить и решить вопросы по сервису.</h1>
            <p className="app-page__subtitle">
              Пишите нам в чат или на почту — команда поддержки отвечает ежедневно с 05:00 до 01:00 по МСК и помогает
              быстро вернуть доступ к сервису.
            </p>

            <div className="support-layout">
              <div className="support-grid">
                <section className="support-card support-chat">
                  <h2 className="support-card__title">Чат с поддержкой</h2>

                  <div className="support-meta support-meta--in-chat">
                    <div className="support-meta__item">
                      <span className="support-meta__label">Email</span>
                      <a href="mailto:support@220v.shop" className="support-meta__value support-meta__link">
                        support@220v.shop
                      </a>
                    </div>
                    <div className="support-meta__item">
                      <span className="support-meta__label">Время работы</span>
                      <span className="support-meta__value">Работаем ежедневно: 05:00–01:00 МСК</span>
                    </div>
                  </div>

                  <div className="support-chat__frame">
                    <div id="TalkMe-container" style={{ height: "clamp(320px, 56dvh, 520px)", width: "100%" }} />
                  </div>
                </section>
              </div>
            </div>
          </div>
        </section>
      </main>

      <LandingFooter />
    </LandingShell>
  );
};

export default Support;
