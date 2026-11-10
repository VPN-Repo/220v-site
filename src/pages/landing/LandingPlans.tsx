// The three subscription plans with live prices, for the landing section and the public /price page.
import { formatRub, type TariffCard } from "@/lib/tariffPrices";

type LandingPlansProps = {
  cards: TariffCard[];
  onSelect: (months: number) => void;
  className?: string;
};

/** What every plan includes: said once above the cards instead of repeated in each. */
export const PLAN_INCLUDES = "все локации · безлимитный трафик* · до 7 устройств · поддержка 05:00–01:00 МСК";

export const LandingPlans = ({ cards, onSelect, className }: LandingPlansProps) => (
  <div className={`plans${className ? ` ${className}` : ""}`}>
    {cards.map((c) => {
      const fullPrice = c.price + c.saving;
      return (
        <div key={c.months} className={`plan${c.featured ? " plan--featured" : ""}`} data-testid={`plan-${c.months}`}>
          {c.discountPercent > 0 ? (
            <span className={`plan__badge${c.featured ? "" : " plan__badge--alt"}`}>−{c.discountPercent}%</span>
          ) : null}
          <div className="plan__head">
            <h3 className="plan__name">{c.label}</h3>
          </div>
          <div className="plan__price">
            <span className="plan__amount">{formatRub(c.price)}</span>
            <span className="plan__currency">₽</span>
            {c.saving > 0 ? <s className="plan__old">{formatRub(fullPrice)} ₽</s> : null}
          </div>
          <p className="plan__period">
            {c.months === 1 ? "Чтобы попробовать без долгих решений" : `≈ ${formatRub(c.perMonth)} ₽ в месяц · ${c.perDay} ₽ в день`}
          </p>
          {c.saving > 0 ? <p className="plan__saving">Экономия {formatRub(c.saving)} ₽</p> : null}
          <button
            type="button"
            className={`btn ${c.featured ? "btn--primary" : "btn--ghost"} btn--wide plan__btn`}
            onClick={() => onSelect(c.months)}
          >
            Выбрать {c.label}
          </button>
        </div>
      );
    })}
  </div>
);

export default LandingPlans;
