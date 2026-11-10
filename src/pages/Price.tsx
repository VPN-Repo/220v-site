import { Link, useNavigate } from "react-router-dom";

import { useTariffCards } from "@/lib/tariffPrices";
import LandingPlans from "@/pages/landing/LandingPlans";

import LandingShell from "@/pages/landing/LandingShell";
import LandingHeader from "@/pages/landing/LandingHeader";
import LandingFooter from "@/pages/landing/LandingFooter";

const Price = () => {
  const navigate = useNavigate();
  const { cards } = useTariffCards();
  return (
  <LandingShell>
    <LandingHeader
      nav={
        <Link to="/" className="nav__link">
          Главная
        </Link>
      }
      cta={
        <Link to="/" className="btn btn--ghost">
          На главную
        </Link>
      }
    />

    <main>
      <section className="price-page">
        <div className="container">
          <div className="price-page__head">
            <h1 className="price-page__title">Тарифы</h1>
            <p className="price-page__subtitle">Выберите срок — чем дольше, тем выгоднее</p>
          </div>

          <LandingPlans cards={cards} className="plans--page" onSelect={(months) => navigate(`/tariff/pay?months=${months}`)} />

          <p className="price-page__note">
            * На серверах категории «Мобильная сеть» действует лимит 35 ГБ в месяц. Подробнее — в{" "}
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

export default Price;
