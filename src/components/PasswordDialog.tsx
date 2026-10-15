import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiPost } from "@/lib/api";
import { formatResendCooldownButtonLabel } from "@/lib/errorMessages";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import PasswordVisibilityButton from "@/components/PasswordVisibilityButton";
import { isValidNewPassword, PASSWORD_REQUIREMENTS, SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/password";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasPassword: boolean;
  onChanged: () => void;
};

const CODE_RE = /^\d{5}$/;

/** Установка/смена пароля из личного кабинета: подтверждается кодом из письма. */
export default function PasswordDialog({ open, onOpenChange, hasPassword, onChanged }: Props) {
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [code, setCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [sent, setSent] = useState(false);
  const [resendCooldownSec, setResendCooldownSec] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || resendCooldownSec <= 0) return;
    const timer = window.setTimeout(() => {
      setResendCooldownSec((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [open, resendCooldownSec]);

  const close = (next: boolean) => {
    if (next) {
      onOpenChange(true);
      return;
    }
    setNewPassword("");
    setRepeatPassword("");
    setCode("");
    setShowPassword(false);
    setSent(false);
    setResendCooldownSec(0);
    setLoading(false);
    onOpenChange(false);
  };

  const validPassword = () => {
    if (!isValidNewPassword(newPassword)) {
      toast.error(PASSWORD_REQUIREMENTS);
      return false;
    }
    if (newPassword !== repeatPassword) {
      toast.error("Пароли не совпадают");
      return false;
    }
    return true;
  };

  const sendCode = async () => {
    if (!validPassword()) return;
    setLoading(true);
    try {
      const { data, error, retryAfterSec } = await apiPost<{ ok?: boolean; retryAfterSec?: number }>(
        "/auth/password/send-code",
        {},
      );
      if (error) {
        if (retryAfterSec) setResendCooldownSec(retryAfterSec);
        throw error;
      }
      if (!data?.ok) throw new Error("Не удалось отправить код");
      setCode("");
      setSent(true);
      setResendCooldownSec(retryAfterSec ?? data.retryAfterSec ?? 60);
      toast.success("Код отправлен на ваш email");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось отправить код");
    } finally {
      setLoading(false);
    }
  };

  const changePassword = async () => {
    if (!validPassword()) return;
    if (!CODE_RE.test(code)) {
      toast.error("Введите код из письма (5 цифр)");
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await apiPost<{ ok?: boolean }>("/auth/password/change", { code, newPassword });
      if (error) throw error;
      if (!data?.ok) throw new Error("Не удалось изменить пароль");
      toast.success("Пароль сохранён. Другие сеансы завершены");
      onChanged();
      close(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось изменить пароль");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="dash-modal sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{hasPassword ? "Сменить пароль" : "Задать пароль"}</DialogTitle>
          <DialogDescription>
            Введите пароль из 6–128 символов с буквами и цифрами дважды и подтвердите его кодом из письма.
          </DialogDescription>
        </DialogHeader>
        <form
          className="dash-modal__stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!loading) void (sent ? changePassword() : sendCode());
          }}
        >
          <div className="password-field">
            <input
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              aria-label="Новый пароль"
              placeholder="6–128 символов, буквы и цифры"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="dash-modal__input"
              disabled={loading}
            />
            <PasswordVisibilityButton
              visible={showPassword}
              onClick={() => setShowPassword(!showPassword)}
              disabled={loading}
            />
          </div>
          <div className="password-field">
            <input
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              aria-label="Повторите пароль"
              placeholder="Повторите пароль"
              value={repeatPassword}
              onChange={(event) => setRepeatPassword(event.target.value)}
              className="dash-modal__input"
              disabled={loading}
            />
            <PasswordVisibilityButton
              visible={showPassword}
              onClick={() => setShowPassword(!showPassword)}
              disabled={loading}
            />
          </div>
          {sent ? (
            <>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                aria-label="Код из email"
                placeholder="Код из email"
                maxLength={5}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                className="dash-modal__input"
                disabled={loading}
              />
              <button
                type="button"
                className="dash-modal__link"
                disabled={loading || resendCooldownSec > 0}
                onClick={() => void sendCode()}
              >
                {resendCooldownSec > 0
                  ? formatResendCooldownButtonLabel(resendCooldownSec)
                  : "Отправить код повторно"}
              </button>
            </>
          ) : null}
          <p className="dash-modal__hint">
            Не приходит код? Напишите в поддержку на <a href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a> — после проверки
            пароль установят за вас.
          </p>
          <button type="submit" className="dash-modal-btn dash-modal-btn--primary" disabled={loading}>
            {loading ? "Подождите..." : sent ? "Сохранить пароль" : "Отправить код"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
