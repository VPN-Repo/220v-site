// Subscription plans with live prices from /billing/meta (RMW tariffs).
// Shared by the landing price section and the cabinet tariff page, so both always show the same numbers.
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";

type BillingMeta = {
  products?: {
    product_key: string;
    price: number | null;
  }[];
};

export type TariffOption = {
  months: number;
  productKey: string;
  label: string;
  fallbackPrice: number;
  featured: boolean;
};

export type TariffCard = TariffOption & {
  price: number;
  saving: number;
  discountPercent: number;
  perMonth: number;
  perDay: number;
};

const readEnvPrice = (value: string | undefined, fallback: number) => {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : fallback;
};

// Only used while /billing/meta is loading or unavailable; the RMW config is the source of truth.
const TARIFF_FALLBACK_PRICES = {
  sub_1m: readEnvPrice(import.meta.env.VITE_TARIFF_PRICE_SUB_1M, 455),
  sub_6m: readEnvPrice(import.meta.env.VITE_TARIFF_PRICE_SUB_6M, 2430),
  sub_12m: readEnvPrice(import.meta.env.VITE_TARIFF_PRICE_SUB_12M, 4060),
};

export const TARIFF_OPTIONS: TariffOption[] = [
  { months: 1, productKey: "sub_1m", label: "1 месяц", fallbackPrice: TARIFF_FALLBACK_PRICES.sub_1m, featured: false },
  { months: 6, productKey: "sub_6m", label: "6 месяцев", fallbackPrice: TARIFF_FALLBACK_PRICES.sub_6m, featured: true },
  { months: 12, productKey: "sub_12m", label: "1 год", fallbackPrice: TARIFF_FALLBACK_PRICES.sub_12m, featured: false },
];

export const formatRub = (value: number) => value.toLocaleString("ru-RU");

export function buildTariffCards(priceByKey: Record<string, number>): TariffCard[] {
  const basePrice = priceByKey["sub_1m"] ?? TARIFF_OPTIONS[0].fallbackPrice;
  return TARIFF_OPTIONS.map((opt) => {
    const price = priceByKey[opt.productKey] ?? opt.fallbackPrice;
    const fullPrice = basePrice * opt.months;
    const saving = Math.max(0, fullPrice - price);
    const discountPercent = fullPrice > 0 ? Math.round((saving / fullPrice) * 100) : 0;
    const perMonth = opt.months > 0 ? Math.round(price / opt.months) : price;
    const perDay = Math.round(price / (opt.months * 30.4));
    return { ...opt, price, saving, discountPercent, perMonth, perDay };
  });
}

/** Plans with live prices; `loading` is true until /billing/meta answers (fallback prices meanwhile). */
export function useTariffCards(): { cards: TariffCard[]; loading: boolean } {
  const [priceByKey, setPriceByKey] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await apiGet<BillingMeta>("/billing/meta");
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const p of data?.products ?? []) {
        if (p?.product_key && typeof p.price === "number" && p.price > 0) next[p.product_key] = p.price;
      }
      setPriceByKey(next);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cards = useMemo(() => buildTariffCards(priceByKey), [priceByKey]);
  return { cards, loading };
}

/** The cheapest monthly price among the plans (the year plan), for «от N ₽ в месяц». */
export function cheapestPerMonth(cards: TariffCard[]): number {
  return Math.min(...cards.map((c) => c.perMonth));
}
