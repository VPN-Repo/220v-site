import { ChevronRight, KeyRound, X } from "lucide-react";

import { dismissPasswordNudge } from "@/lib/passwordNudge";

/**
 * Мягкое предложение задать пароль: вместо полей пароля на экране кода.
 * Показывается, только когда пароля нет, и скрывается на 30 дней по ×.
 */
const PasswordNudge = ({ onSetPassword, onDismiss }: { onSetPassword: () => void; onDismiss: () => void }) => (
  <aside className="ref-promo ref-promo--password" data-testid="password-nudge" aria-label="Пароль для входа">
    <button type="button" className="ref-promo__main" onClick={onSetPassword}>
      <span className="ref-promo__icon" aria-hidden="true">
        <KeyRound className="h-5 w-5" />
      </span>
      <span className="ref-promo__text">Задайте пароль, чтобы входить без кода из письма</span>
      <span className="ref-promo__pill">
        Задать
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </span>
    </button>
    <button
      type="button"
      className="ref-promo__close"
      aria-label="Скрыть на 30 дней"
      onClick={() => {
        dismissPasswordNudge();
        onDismiss();
      }}
    >
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
  </aside>
);

export default PasswordNudge;
