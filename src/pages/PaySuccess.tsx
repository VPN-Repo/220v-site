import { useNavigate } from "react-router-dom";
import { BookOpen, CheckCircle2, Gift } from "lucide-react";

import successMascot from "@/assets/pay-success-mascot.png";
import LandingFooter from "@/pages/landing/LandingFooter";
import LandingHeader from "@/pages/landing/LandingHeader";
import LandingShell from "@/pages/landing/LandingShell";
import ReferralShare from "@/components/ReferralShare";
import { useSession } from "@/hooks/useSession";
import { buildReferralLink, useReferralConfig } from "@/lib/referralPromo";

export const PAY_SUCCESS_REFERRAL_TITLE = "Довольны соединением? Делитесь ссылкой — баллы за каждую подписку, которую оплатит друг";

/** Referral invite under the payment confirmation; only for a signed-in user the program is open to. */
const PaySuccessReferral = () => {
  const navigate = useNavigate();
  const { status, user } = useSession();
  const link =
    typeof window !== "undefined" ? buildReferralLink(window.location.origin, user?.userUuid) : "";
  const { config } = useReferralConfig(status === "authed" && Boolean(link));

  if (!link || !config?.available) return null;

  return (
    <section className="pay-success__ref" aria-labelledby="pay-success-ref-title" data-testid="pay-success-referral">
      <div className="pay-success__ref-head">
        <span className="pay-success__ref-icon" aria-hidden="true">
          <Gift className="h-5 w-5" />
        </span>
        <h2 id="pay-success-ref-title">{PAY_SUCCESS_REFERRAL_TITLE}</h2>
      </div>
      <ReferralShare link={link} />
      <button type="button" className="pay-success__ref-more" onClick={() => navigate("/referrals")}>
        Как работает программа
      </button>
    </section>
  );
};

const PaySuccess = () => {
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
        <section className="pay-success">
          <div className="container pay-success__container">
            <article className="pay-success__card" aria-labelledby="pay-success-title">
              <div className="pay-success__mascot-wrap">
                <div className="pay-success__mascot-glow" aria-hidden="true" />
                <img
                  src={successMascot}
                  alt="Маскот 220v"
                  className="pay-success__mascot"
                  width={1024}
                  height={910}
                  loading="lazy"
                  decoding="async"
                />
              </div>

              <div className="pay-success__badge">
                <CheckCircle2 aria-hidden="true" />
                Оплата подтверждена
              </div>

              <h1 id="pay-success-title">Оплата прошла успешно</h1>
              <p>Спасибо! Можете открыть личный кабинет или сразу перейти к инструкции по подключению.</p>

              <div className="pay-success__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--lg"
                  onClick={() => navigate("/dashboard", { replace: true })}
                >
                  В личный кабинет
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--lg"
                  onClick={() => navigate("/instructions", { replace: true })}
                >
                  <BookOpen className="btn__icon" aria-hidden="true" />
                  Инструкции
                </button>
              </div>

              <PaySuccessReferral />
            </article>
          </div>
        </section>
      </main>

      <LandingFooter />
    </LandingShell>
  );
};

export default PaySuccess;
