import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { apiGet, apiPost } from "@/lib/api";
import type { BillingPaymentMethod } from "@/lib/paymentMethods";
import DashboardSidebar from "@/components/DashboardSidebar";
import { useDashboardSidebarItems } from "@/hooks/useDashboardSidebarItems";
import LandingShell from "@/pages/landing/LandingShell";
import LandingFooter from "@/pages/landing/LandingFooter";
import { subscriptionEndLabel } from "@/lib/lteTraffic";

type BillingMeta = {
  payments?: BillingPaymentMethod[];
  products?: { product_key: string; price: number | null }[];
};

const TRAFFIC_PRODUCT_KEY: Record<number, string> = {
  20: "traffic_20gb",
  50: "traffic_50gb",
};

const GB_LABEL: Record<number, string> = {
  20: "+20 ГБ LTE",
  50: "+50 ГБ LTE",
};

const DEFAULT_PAYMENTS: BillingPaymentMethod[] = [
  { id: 2, type: "sbp", label: "СБП (QR-код)" },
  { id: 11, type: "card", label: "Оплата картой" },
  { id: 13, type: "crypto", label: "Криптовалюта" },
];

const TrafficPay = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const gb = Number(params.get("gb") ?? "");
  const productKey = TRAFFIC_PRODUCT_KEY[gb];

  const {
    email,
    items,
    handleLogout,
    userUuid,
    userLoading,
    userError,
    trafficRestriction,
    user,
  } = useDashboardSidebarItems();

  const [billingMeta, setBillingMeta] = useState<BillingMeta | null>(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [paymentLoading, setPaymentLoading] = useState<number | null>(null);
  useEffect(() => {
    if (!productKey) {
      navigate("/traffic", { replace: true });
    }
  }, [productKey, navigate]);

  useEffect(() => {
    if (!productKey) return;
    let cancelled = false;
    setBillingLoading(true);
    setBillingError(null);
    (async () => {
      try {
        const { data, error } = await apiGet<BillingMeta>("/billing/meta");
        if (cancelled) return;
        if (error) {
          setBillingError(error.message ?? "Не удалось загрузить пакеты трафика");
          return;
        }
        if (data && typeof data === "object") {
          setBillingMeta(data);
        }
      } catch (err) {
        if (!cancelled) {
          setBillingError(
            err instanceof Error ? err.message : "Ошибка загрузки данных",
          );
        }
      } finally {
        if (!cancelled) setBillingLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [productKey]);

  const paymentMethods = billingMeta?.payments?.length ? billingMeta.payments : DEFAULT_PAYMENTS;

  const price = useMemo(() => {
    const product = billingMeta?.products?.find((p) => p.product_key === productKey);
    return typeof product?.price === "number" ? product.price : null;
  }, [billingMeta, productKey]);

  const handlePayment = async (paymentMethod: number) => {
    if (!userUuid || !productKey || userLoading || userError || trafficRestriction) return;
    setPaymentLoading(paymentMethod);
    try {
      const { data, error: fnError } = await apiPost<{ payment_url?: string }>("/checkout", {
        product_key: productKey,
        payment_method: paymentMethod,
      });
      if (fnError) throw fnError;
      const paymentUrl =
        data &&
        typeof data === "object" &&
        "payment_url" in data &&
        typeof (data as { payment_url: unknown }).payment_url === "string"
          ? (data as { payment_url: string }).payment_url
          : "";
      if (paymentUrl) {
        window.location.href = paymentUrl;
      } else {
        toast.error("Не удалось получить ссылку на оплату");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ошибка при создании платежа";
      toast.error(message);
    } finally {
      setPaymentLoading(null);
    }
  };

  const handlePaymentMethodClick = (method: BillingPaymentMethod) => {
    void handlePayment(method.id);
  };

  const loading = userLoading || billingLoading;
  const error = userError ?? billingError ?? trafficRestriction;

  return (
    <LandingShell className="landing-root--with-sidebar">
      <DashboardSidebar items={items} onLogout={handleLogout} email={email || undefined} />

      <main>
        <section className="price-page">
          <div className="container">
            <div className="price-page__head">
              <h1 className="price-page__title">Оплата LTE-трафика</h1>
              <p className="price-page__subtitle">
                {productKey
                  ? `Пакет ${GB_LABEL[gb]}${
                      price != null ? ` — ${price.toLocaleString("ru-RU")} ₽` : ""
                    }`
                  : "Пакет не выбран"}
              </p>
            </div>

            <div className="pay-page">
              <button
                type="button"
                className="pay-page__back"
                onClick={() => navigate("/traffic")}
              >
                ← К выбору пакета
              </button>

              <div className="pay-page__card">
                {loading ? (
                  <div className="pay-page__loading">
                    <Loader2 className="pay-page__spinner" aria-label="Загрузка" />
                  </div>
                ) : error ? (
                  <div className="pay-page__error">
                    <p>{error}</p>
                    <button
                      type="button"
                      className="btn btn--ghost btn--wide"
                      onClick={() => navigate(trafficRestriction ? "/tariff" : "/traffic")}
                    >
                      {trafficRestriction ? "К тарифам" : "Вернуться к пакетам"}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="lte-summary" data-testid="traffic-purchase-summary">
                      <p className="lte-summary__text">
                        Вы покупаете: <strong>+{gb} ГБ LTE-трафика</strong>
                        {price != null ? (
                          <>
                            {" "}· <strong>{price.toLocaleString("ru-RU")} ₽</strong>
                          </>
                        ) : null}
                        . Действует до {subscriptionEndLabel(user)}. Срок подписки не продлевается.
                      </p>
                      <button type="button" className="lte-summary__link" onClick={() => navigate("/tariff")}>
                        Мне нужно продлить подписку →
                      </button>
                    </div>
                    <span className="plan__eyebrow">Способ оплаты</span>
                    <div className="pay-page__methods">
                      {paymentMethods.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="btn btn--ghost btn--wide pay-page__method"
                          disabled={paymentLoading !== null || !userUuid}
                          onClick={() => handlePaymentMethodClick(m)}
                        >
                          {paymentLoading === m.id ? (
                            <Loader2 className="pay-page__spinner pay-page__spinner--sm" aria-label="Загрузка" />
                          ) : (
                            m.label
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      <LandingFooter />

    </LandingShell>
  );
};

export default TrafficPay;
