import { suggestEmailFix } from "@/lib/emailTypos";

type EmailTypoHintProps = {
  email: string;
  onApply: (fixed: string) => void;
  className?: string;
  buttonClassName?: string;
  disabled?: boolean;
};

/** Non-blocking "did you mean" hint with a one-tap fix. Renders nothing when the email looks fine. */
export const EmailTypoHint = ({ email, onApply, className, buttonClassName, disabled }: EmailTypoHintProps) => {
  const suggestion = suggestEmailFix(email);
  if (!suggestion) return null;
  return (
    <p className={className} role="status" data-testid="email-typo-hint">
      Возможно, вы имели в виду <b>{suggestion}</b>?{" "}
      <button type="button" className={buttonClassName} onClick={() => onApply(suggestion)} disabled={disabled}>
        Исправить
      </button>
    </p>
  );
};
