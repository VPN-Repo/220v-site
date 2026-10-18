import { checkEmailTypo } from "@/lib/emailTypos";

type EmailTypoHintProps = {
  email: string;
  onApply: (fixed: string) => void;
  className?: string;
  buttonClassName?: string;
  disabled?: boolean;
};

/** Non-blocking "did you mean" hint with a one-tap fix. Renders nothing when the email looks fine. */
export const EmailTypoHint = ({ email, onApply, className, buttonClassName, disabled }: EmailTypoHintProps) => {
  const typo = checkEmailTypo(email);
  if (!typo) return null;
  const { suggestion, domainChanged, localIssues } = typo;
  return (
    <p className={className} role="status" data-testid="email-typo-hint">
      {domainChanged || localIssues.length === 0 ? (
        <>
          Возможно, вы имели в виду <b>{suggestion}</b>?
        </>
      ) : (
        <>Похоже, в адресе опечатка: {localIssues.join(", ")}</>
      )}{" "}
      <button type="button" className={buttonClassName} onClick={() => onApply(suggestion)} disabled={disabled}>
        Исправить
      </button>
    </p>
  );
};
