import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { RotateCcw, XCircle } from "lucide-react";

import failMascot from "@/assets/pay-fail-mascot.png";
import LandingFooter from "@/pages/landing/LandingFooter";
import LandingHeader from "@/pages/landing/LandingHeader";
import LandingShell from "@/pages/landing/LandingShell";
import { track } from "@/lib/funnel";

const PayFail = () => {
  useEffect(() => {
    track("pay_fail_view", { once: true });
  }, []);
  const navigate = useNavigate();

  return (
    <LandingShell>
      <LandingHeader
        nav={
          <button type="button" className="nav__link" onClick={() => navigate("/")}>
            Главная
          </button>
        }
        cta={
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => navigate("/dashboard", { replace: true })}
          >
            Личный кабинет
          </button>
        }
      />

      <main>
        <section className="pay-result pay-result--fail">
          <div className="container pay-result__container">
            <article className="pay-result__card" aria-labelledby="pay-fail-title">
              <div className="pay-result__mascot-wrap">
                <div className="pay-result__mascot-glow" aria-hidden="true" />
                <img
                  src={failMascot}
                  alt="Маскот 220v"
                  className="pay-result__mascot"
                  width={1024}
                  height={859}
                  loading="lazy"
                  decoding="async"
                />
              </div>

              <div className="pay-result__badge">
                <XCircle aria-hidden="true" />
                Оплата не подтверждена
              </div>

              <h1 id="pay-fail-title">Оплата не завершена</h1>
              <p>Платёж отменён или не прошёл. Вы можете вернуться в личный кабинет и попробовать снова.</p>

              <div className="pay-result__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--lg"
                  onClick={() => navigate("/dashboard", { replace: true })}
                >
                  <RotateCcw className="btn__icon" aria-hidden="true" />
                  Попробовать снова
                </button>
                <button type="button" className="btn btn--ghost btn--lg" onClick={() => navigate("/")}>
                  На главную
                </button>
              </div>
            </article>
          </div>
        </section>
      </main>

      <LandingFooter />
    </LandingShell>
  );
};

export default PayFail;
