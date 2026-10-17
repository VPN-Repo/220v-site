import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { apiGet } from "@/lib/api";
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

type BillingMeta = {
  products?: {
    product_key: string;
    price: number | null;
  }[];
};

type TariffOption = {
  months: number;
  productKey: string;
  label: string;
  fallbackPrice: number;
  featured: boolean;
};

const readEnvPrice = (value: string | undefined, fallback: number) => {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : fallback;
};

const TARIFF_FALLBACK_PRICES = {
  sub_1m: readEnvPrice(import.meta.env.VITE_TARIFF_PRICE_SUB_1M, 450),
  sub_6m: readEnvPrice(import.meta.env.VITE_TARIFF_PRICE_SUB_6M, 2400),
  sub_12m: readEnvPrice(import.meta.env.VITE_TARIFF_PRICE_SUB_12M, 4000),
};

const TARIFF_OPTIONS: TariffOption[] = [
  {
    months: 1,
    productKey: "sub_1m",
    label: "1 месяц",
    fallbackPrice: TARIFF_FALLBACK_PRICES.sub_1m,
    featured: false,
  },
  {
    months: 6,
    productKey: "sub_6m",
    label: "6 месяцев",
    fallbackPrice: TARIFF_FALLBACK_PRICES.sub_6m,
    featured: true,
  },
  {
    months: 12,
    productKey: "sub_12m",
    label: "1 год",
    fallbackPrice: TARIFF_FALLBACK_PRICES.sub_12m,
    featured: false,
  },
];

const formatRub = (value: number) => value.toLocaleString("ru-RU");

const Tariff = () => {
  const navigate = useNavigate();
  const { email, items, handleLogout, userLoading, userError, trafficRestriction, user } = useDashboardSidebarItems();
  const [priceByKey, setPriceByKey] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

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
    const basePrice = priceByKey["sub_1m"] ?? TARIFF_OPTIONS[0].fallbackPrice;
    return TARIFF_OPTIONS.map((opt) => {
      const price = priceByKey[opt.productKey] ?? opt.fallbackPrice;
      const fullPrice = basePrice * opt.months;
      const saving = Math.max(0, fullPrice - price);
      const discountPercent = fullPrice > 0 ? Math.round((saving / fullPrice) * 100) : 0;
      const perMonth = opt.months > 0 ? Math.round(price / opt.months) : price;
      return { ...opt, price, saving, discountPercent, perMonth };
    });
  }, [priceByKey]);

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
                  ? "Что вы получите: +1/6/12 мес. доступа"
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
              Безлимитный трафик* на всех локациях. Кроме LTE серверов - лимит 30 ГБ в месяц. Поддержка ежедневно с 05:00 до 01:00 (МСК). Подробнее — в{" "}
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
