// The three subscription plans with live prices, for the landing section and the public /price page.
import { formatRub, type TariffCard } from "@/lib/tariffPrices";

type LandingPlansProps = {
  cards: TariffCard[];
  onSelect: (months: number) => void;
  className?: string;
};

const BASE_FEATURES = ["Все локации", "Безлимитный трафик*", "До 7 устройств на аккаунт", "Поддержка ежедневно 05:00–01:00 МСК"];

export const LandingPlans = ({ cards, onSelect, className }: LandingPlansProps) => (
  <div className={`plans${className ? ` ${className}` : ""}`}>
    {cards.map((c) => {
      const fullPrice = c.price + c.saving;
      return (
        <div key={c.months} className={`plan${c.featured ? " plan--featured" : ""}`} data-testid={`plan-${c.months}`}>
          {c.featured ? (
            <span className="plan__badge">Выбор большинства</span>
          ) : c.discountPercent > 0 ? (
            <span className="plan__badge plan__badge--alt">−{c.discountPercent}%</span>
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
          <ul className="plan__features" role="list">
            {BASE_FEATURES.map((f) => (
              <li key={f}>{f}</li>
            ))}
            {c.saving > 0 ? <li>Экономия {formatRub(c.saving)} ₽</li> : null}
          </ul>
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
