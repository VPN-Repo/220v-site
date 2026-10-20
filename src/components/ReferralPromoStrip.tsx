import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Gift, X } from "lucide-react";

import {
  dismissReferralPromo,
  isReferralPromoDismissed,
  maxFirstPaymentPoints,
  pluralPoints,
  useReferralConfig,
} from "@/lib/referralPromo";

export const REFERRAL_PROMO_SHORT_TEXT = "Пригласите друга и получайте баллы за его оплаты";

/**
 * Referral teaser at the top of the dashboard. Shown only when the program is open
 * for this user (not blocked, and RMW does not report a missing paid tariff), and
 * hidden for 14 days after the × is pressed.
 */
const ReferralPromoStrip = () => {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(isReferralPromoDismissed);
  const { config } = useReferralConfig(!dismissed);

  if (dismissed || !config || !config.available || config.eligible === false) return null;

  const maxPoints = maxFirstPaymentPoints(config);
  const fullText = maxPoints
    ? `Хотите пользоваться бесплатно? Пригласите друга — до ${maxPoints} ${pluralPoints(maxPoints)} за его оплату, ${config.pointsPerDay} ${pluralPoints(config.pointsPerDay)} = 1 день подписки`
    : null;

  return (
    <aside className="ref-promo" data-testid="referral-promo" aria-label="Реферальная программа">
      <button type="button" className="ref-promo__main" onClick={() => navigate("/referrals")}>
        <span className="ref-promo__icon" aria-hidden="true">
          <Gift className="h-5 w-5" />
        </span>
        {fullText ? (
          <>
            <span className="ref-promo__text ref-promo__text--full">{fullText}</span>
            <span className="ref-promo__text ref-promo__text--short">{REFERRAL_PROMO_SHORT_TEXT}</span>
          </>
        ) : (
          <span className="ref-promo__text">{REFERRAL_PROMO_SHORT_TEXT}</span>
        )}
        <span className="ref-promo__pill">
          Пригласить
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </span>
      </button>
      <button
        type="button"
        className="ref-promo__close"
        aria-label="Скрыть на 14 дней"
        onClick={() => {
          dismissReferralPromo();
          setDismissed(true);
        }}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </aside>
  );
};

export default ReferralPromoStrip;
