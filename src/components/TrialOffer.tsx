// The offer for a test-drive account: how much of the test is left and the plan most people take.
// Shown in the cabinet once the first device is connected, and when the test is over.
import { useEffect } from "react";
import { Zap } from "lucide-react";
import { track } from "@/lib/funnel";
import { formatRub, useTariffCards } from "@/lib/tariffPrices";

type TrialOfferProps = {
  msLeft: number;
  expired: boolean;
  onChoose: (months: number) => void;
  onAllPlans: () => void;
};

export function trialLeftLabel(msLeft: number): string {
  const minutes = Math.max(0, Math.round(msLeft / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest >= 10 ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

export const TrialOffer = ({ msLeft, expired, onChoose, onAllPlans }: TrialOfferProps) => {
  const { cards } = useTariffCards();
  const featured = cards.find((c) => c.featured) ?? cards[0];

  useEffect(() => {
    track("trial_offer_view", { once: true });
  }, []);

  return (
    <section className={`trial-offer${expired ? " trial-offer--expired" : ""}`} aria-labelledby="trial-offer-title">
      <div className="trial-offer__icon" aria-hidden="true">
        <Zap className="h-5 w-5" />
      </div>
      <div className="trial-offer__body">
        <h2 className="trial-offer__title" id="trial-offer-title">
          {expired ? "Тест-драйв закончился" : `Тест-драйв: осталось ${trialLeftLabel(msLeft)}`}
        </h2>
        <p className="trial-offer__text">
          {expired
            ? "Выберите тариф — доступ вернётся на тех же устройствах, ничего настраивать заново не нужно."
            : "Всё работает? Оформите тариф сейчас, и доступ продолжится без перерыва на тех же устройствах."}
        </p>
        {featured ? (
          <p className="trial-offer__price">
            {featured.label} — {formatRub(featured.price)} ₽, это ≈ {formatRub(featured.perMonth)} ₽ в месяц
          </p>
        ) : null}
        <div className="trial-offer__actions">
          <button
            type="button"
            className="trial-offer__cta"
            onClick={() => {
              track("trial_offer_click");
              onChoose(featured?.months ?? 6);
            }}
          >
            {expired ? "Вернуть доступ" : `Оформить на ${featured?.label ?? "6 месяцев"}`}
          </button>
          <button type="button" className="trial-offer__link" onClick={onAllPlans}>
            Все тарифы
          </button>
        </div>
      </div>
    </section>
  );
};

export default TrialOffer;
