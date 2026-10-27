import type { ActivePromo } from "@/lib/promo";

/** Плашка на экранах оплаты: цена показана без скидки, итог посчитает биллинг при создании платежа. */
export default function PromoCheckoutNotice({ promo }: { promo: ActivePromo | null }) {
  if (!promo) return null;
  return (
    <div className="lte-summary promo-summary" role="status" data-testid="promo-checkout-notice">
      <p className="lte-summary__text">
        Промокод <strong>{promo.code}</strong>: скидка будет учтена при оплате, цена выше указана без неё.
      </p>
    </div>
  );
}
