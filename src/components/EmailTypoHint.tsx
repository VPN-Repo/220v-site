import { checkEmailTypo } from "@/lib/emailTypos";

type EmailTypoHintProps = {
  email: string;
  onApply: (fixed: string) => void;
  className?: string;
  buttonClassName?: string;
  disabled?: boolean;
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Non-blocking "did you mean" hint with a one-tap fix. Renders nothing when the email looks fine. */
export const EmailTypoHint = ({ email, onApply, className, buttonClassName, disabled }: EmailTypoHintProps) => {
  const typo = checkEmailTypo(email);
  if (!typo) return null;
  const { suggestion, domainChanged, localIssues } = typo;
  return (
    <p className={className} role="status" data-testid="email-typo-hint">
      {domainChanged || localIssues.length === 0 ? (
        <>
          Похоже на опечатку — может, <b>{suggestion}</b>?
        </>
      ) : (
        <>{capitalize(localIssues.join(", "))} — проверьте адрес</>
      )}{" "}
      <button type="button" className={buttonClassName} onClick={() => onApply(suggestion)} disabled={disabled}>
        Исправить адрес
      </button>
    </p>
  );
};
