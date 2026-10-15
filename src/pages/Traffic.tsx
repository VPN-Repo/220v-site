import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { apiGet } from "@/lib/api";
import DashboardSidebar from "@/components/DashboardSidebar";
import { useDashboardSidebarItems } from "@/hooks/useDashboardSidebarItems";
import LandingShell from "@/pages/landing/LandingShell";
import LandingFooter from "@/pages/landing/LandingFooter";
import {
  lteTrafficExplainer,
  renewInsteadWarningText,
  shouldWarnRenewInstead,
  subscriptionEndLabel,
  subscriptionMsLeft,
} from "@/lib/lteTraffic";

type BillingMeta = {
  products?: {
    product_key: string;
    price: number | null;
  }[];
};

type TrafficOption = {
  gb: number;
  productKey: string;
  label: string;
  fallbackPrice: number;
};

const TRAFFIC_OPTIONS: TrafficOption[] = [
  { gb: 20, productKey: "traffic_20gb", label: "+20 ГБ LTE", fallbackPrice: 150 },
  { gb: 50, productKey: "traffic_50gb", label: "+50 ГБ LTE", fallbackPrice: 300 },
];

const formatRub = (value: number) => value.toLocaleString("ru-RU");

const Traffic = () => {
  const navigate = useNavigate();
  const { email, items, handleLogout, userLoading, userError, trafficRestriction, user } = useDashboardSidebarItems();
  const [priceByKey, setPriceByKey] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [renewWarningDismissed, setRenewWarningDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await apiGet<BillingMeta>("/billing/meta");
      if (cancelled) return;
      const next: Record<string, number> = {};
      if (data?.products) {
        for (const p of data.products) {
          if (p?.product_key && typeof p.price === "number") {
            next[p.product_key] = p.price;
          }
        }
      }
      setPriceByKey(next);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cards = useMemo(() => {
    return TRAFFIC_OPTIONS.map((opt) => {
      const price = priceByKey[opt.productKey] ?? opt.fallbackPrice;
      const perGb = opt.gb > 0 ? Math.round(price / opt.gb) : price;
      return { ...opt, price, perGb };
    });
  }, [priceByKey]);

  const userReady = !userLoading && !userError && user != null;
  const msLeft = subscriptionMsLeft(user);
  const endLabel = subscriptionEndLabel(user);
  const showRenewInsteadWarning =
    userReady && !renewWarningDismissed && shouldWarnRenewInstead(msLeft, trafficRestriction);

  return (
    <LandingShell className="landing-root--with-sidebar">
      <DashboardSidebar
        items={items}
        onLogout={handleLogout}
        email={email || undefined}
        mobileTitle="Докупка LTE-трафика"
      />

      <main>
        <section className="price-page">
          <div className="container">
            <div className="price-page__head">
              <h1 className="price-page__title price-page__title--mobile-hidden">Докупка LTE-трафика</h1>
              {userReady ? <p className="price-page__subtitle">{lteTrafficExplainer(endLabel)}</p> : null}
            </div>

            {!userLoading && (userError || trafficRestriction) && (
              <p className="price-page__note" role="status">
                {userError || trafficRestriction} <Link to="/tariff" className="modal__link">К тарифам</Link>
              </p>
            )}

            {showRenewInsteadWarning ? (
              <div className="lte-notice" role="alert">
                <p className="lte-notice__text">{renewInsteadWarningText(msLeft, endLabel)}</p>
                <div className="lte-notice__actions">
                  <button type="button" className="btn btn--primary btn--wide" onClick={() => navigate("/tariff")}>
                    Продлить подписку
                  </button>
                  <button type="button" className="lte-notice__link" onClick={() => setRenewWarningDismissed(true)}>
                    Всё равно докупить трафик
                  </button>
                </div>
              </div>
            ) : (
              <div className="plans plans--page">
                {cards.map((c) => (
                  <div key={c.gb} className="plan">
                    <div className="plan__block">
                      <span className="plan__eyebrow">Пакет</span>
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
                      <p className="plan__period">≈ {formatRub(c.perGb)} ₽ / ГБ</p>
                    </div>

                    <button
                      type="button"
                      className="btn btn--ghost btn--wide plan__btn"
                      disabled={loading || userLoading || Boolean(userError || trafficRestriction)}
                      onClick={() => navigate(`/traffic/pay?gb=${c.gb}`)}
                    >
                      Выбрать
                    </button>
                  </div>
                ))}
              </div>
            )}

            <p className="price-page__note">
              Подробнее об LTE-трафике — в{" "}
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

export default Traffic;
