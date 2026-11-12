import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";

import { formatRub, useTariffCards } from "@/lib/tariffPrices";
import DashboardSidebar from "@/components/DashboardSidebar";
import { useDashboardSidebarItems } from "@/hooks/useDashboardSidebarItems";
import LandingShell from "@/pages/landing/LandingShell";
import LandingFooter from "@/pages/landing/LandingFooter";
import {
  isActivePaidSubscription,
  shouldHintTrafficInstead,
  subscriptionMsLeft,
  trafficInsteadHintText,
} from "@/lib/lteTraffic";
import { track } from "@/lib/funnel";

const Tariff = () => {
  useEffect(() => {
    track("buy_open", { once: true });
  }, []);
  const navigate = useNavigate();
  const { email, items, handleLogout, userLoading, userError, trafficRestriction, user } = useDashboardSidebarItems();
  const { cards, loading } = useTariffCards();

  const userReady = !userLoading && !userError && user != null;
  const msLeft = subscriptionMsLeft(user);
  const isRenewal = userReady && isActivePaidSubscription(user, msLeft);
  const showTrafficInsteadHint = userReady && shouldHintTrafficInstead(user, msLeft, trafficRestriction);
  const title = isRenewal ? "Продление подписки" : "Купить тариф";

  return (
    <LandingShell className="landing-root--with-sidebar">
      <DashboardSidebar
        items={items}
        onLogout={handleLogout}
        email={email || undefined}
        mobileTitle={isRenewal ? title : "Покупка тарифа"}
      />

      <main>
        <section className="price-page">
          <div className="container">
            <div className="price-page__head">
              <h1 className="price-page__title price-page__title--mobile-hidden">{title}</h1>
              <p className="price-page__subtitle">
                {isRenewal
                  ? "Оплаченные месяцы прибавятся к вашей текущей подписке"
                  : "Выберите срок подписки — чем дольше, тем выгоднее"}
              </p>
            </div>

            {showTrafficInsteadHint ? (
              <div className="lte-notice" data-testid="traffic-instead-hint">
                <p className="lte-notice__text">{trafficInsteadHintText(msLeft)}</p>
                <div className="lte-notice__actions">
                  <button type="button" className="btn btn--primary btn--wide" onClick={() => navigate("/traffic")}>
                    Докупить LTE-трафик
                  </button>
                </div>
              </div>
            ) : null}

            <div className="plans plans--page">
              {cards.map((c) => (
                <div key={c.months} className={`plan${c.featured ? " plan--featured" : ""}`}>
                  {c.discountPercent > 0 ? (
                    <span
                      className={`plan__badge${c.featured ? "" : " plan__badge--alt"}`}
                    >
                      −{c.discountPercent}%
                    </span>
                  ) : null}

                  <div className="plan__block">
                    <span className="plan__eyebrow">Тариф</span>
                    <div className="plan__head">
                      <h3 className="plan__name">{c.label}</h3>
                    </div>
                  </div>

                  <div className="plan__block">
                    <span className="plan__eyebrow">Цена</span>
                    <div className="plan__price">
                      <span className="plan__amount">{formatRub(c.price)}</span>
                      <span className="plan__currency">₽</span>
                    </div>
                    <p className="plan__period">≈ {formatRub(c.perMonth)} ₽ / месяц</p>
                  </div>

                  <div className="plan__block plan__benefit">
                    <span className="plan__eyebrow">Выгода</span>
                    {c.discountPercent > 0 ? (
                      <>
                        <div className="plan__benefit-value">−{c.discountPercent}%</div>
                        <p className="plan__benefit-note">
                          Экономия {formatRub(c.saving)} ₽ от месячной цены
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="plan__benefit-value plan__benefit-value--muted">
                          Базовая цена
                        </div>
                        <p className="plan__benefit-note">
                          Подходит, чтобы попробовать сервис
                        </p>
                      </>
                    )}
                  </div>

                  <button
                    type="button"
                    className={`btn ${c.featured ? "btn--primary" : "btn--ghost"} btn--wide plan__btn`}
                    disabled={loading}
                    onClick={() => navigate(`/tariff/pay?months=${c.months}`)}
                  >
                    Выбрать
                  </button>
                </div>
              ))}
            </div>

            <p className="price-page__note">
              Безлимитный трафик* на всех локациях. Кроме серверов «Мобильная сеть» — там 35 ГБ в месяц. Поддержка ежедневно с 05:00 до 01:00 (МСК). Подробнее — в{" "}
              <Link to="/terms" className="modal__link">
                условиях использования
              </Link>
              .
            </p>
          </div>
        </section>
      </main>

      <LandingFooter />
    </LandingShell>
  );
};

export default Tariff;
