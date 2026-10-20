import { FormEvent, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, MailX } from "lucide-react";

import LandingFooter from "@/pages/landing/LandingFooter";
import LandingHeader from "@/pages/landing/LandingHeader";
import LandingShell from "@/pages/landing/LandingShell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { apiPost } from "@/lib/api";

const REASONS = [
  {
    value: "too_many_emails",
    title: "Писем слишком много",
    desc: "Хочу получать меньше уведомлений от сервиса.",
  },
  {
    value: "not_relevant",
    title: "Мне это неактуально",
    desc: "Рассылки больше не помогают пользоваться сервисом.",
  },
  {
    value: "no_longer_use",
    title: "Больше не пользуюсь 220v",
    desc: "Сейчас сервис не нужен или подписка больше не активна.",
  },
  {
    value: "using_other_service",
    title: "Использую другой сервис",
    desc: "Перешёл на другое решение и хочу отключить письма.",
  },
  {
    value: "other",
    title: "Другое",
    desc: "Коротко укажу свою причину перед подтверждением.",
  },
] as const;

type Reason = (typeof REASONS)[number]["value"];
type SubmitState = "idle" | "submitting" | "success";

function UnsubscribeResult({
  icon,
  title,
  text,
}: {
  icon: "invalid" | "success";
  title: string;
  text: string;
}) {
  const Icon = icon === "success" ? CheckCircle2 : AlertCircle;
  return (
    <article className="unsubscribe-card unsubscribe-card--result" aria-labelledby="unsubscribe-result-title">
      <div className={`unsubscribe-status unsubscribe-status--${icon}`}>
        <Icon aria-hidden="true" />
      </div>
      <h1 id="unsubscribe-result-title">{title}</h1>
      <p>{text}</p>
      <Link to="/" className="btn btn--ghost btn--lg">
        На главную
      </Link>
    </article>
  );
}

const UnsubscribeEmail = () => {
  const [searchParams] = useSearchParams();
  const token = useMemo(() => searchParams.get("t")?.trim() || "", [searchParams]);
  const [reason, setReason] = useState<Reason | "">("");
  const [otherReason, setOtherReason] = useState("");
  const [formError, setFormError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [modalError, setModalError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");

  const selectedReason = REASONS.find((item) => item.value === reason);

  function validateReason() {
    if (!reason) return "Укажите причину отписки";
    if (reason === "other" && !otherReason.trim()) return "Укажите причину отписки";
    return "";
  }

  function handleContinue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validateReason();
    setSubmitError("");
    setFormError(error);
    if (error) return;
    setConsent(false);
    setModalError("");
    setConfirmOpen(true);
  }

  async function handleConfirm() {
    if (!consent) {
      setModalError("Подтвердите отписку");
      return;
    }

    setSubmitState("submitting");
    setSubmitError("");
    setModalError("");

    const result = await apiPost<{ ok: true }>("/email/unsubscribe", {
      token,
      reason,
      otherReason: reason === "other" ? otherReason.trim() : "",
      consent: true,
    });

    if (result.error) {
      setSubmitState("idle");
      setSubmitError(result.error.message);
      setConfirmOpen(false);
      return;
    }

    setConfirmOpen(false);
    setSubmitState("success");
  }

  return (
    <LandingShell className="landing-root--unsubscribe">
      <LandingHeader
        nav={
          <Link to="/" className="nav__link">
            Главная
          </Link>
        }
        cta={
          <Link to="/dashboard" className="btn btn--ghost">
            Личный кабинет
          </Link>
        }
      />

      <main>
        <section className="unsubscribe-page">
          <div className="container unsubscribe-page__container">
            {!token ? (
              <UnsubscribeResult
                icon="invalid"
                title="Ссылка недействительна"
                text="Похоже, ссылка на отписку повреждена или была скопирована не полностью."
              />
            ) : submitState === "success" ? (
              <UnsubscribeResult
                icon="success"
                title="Вы отписаны от email-рассылки"
                text="Мы больше не будем отправлять вам маркетинговые письма. Сервисные сообщения по оплате и безопасности могут приходить отдельно."
              />
            ) : (
              <article className="unsubscribe-card" aria-labelledby="unsubscribe-title">
                <div className="unsubscribe-card__icon" aria-hidden="true">
                  <MailX />
                </div>
                <p className="unsubscribe-card__eyebrow">Email-рассылка 220v</p>
                <h1 id="unsubscribe-title">Отписка от писем</h1>
                <p className="unsubscribe-card__lead">
                  Выберите причину, чтобы продолжить. Ответ нужен только для подтверждения действия и не будет сохранён.
                </p>

                <form className="unsubscribe-form" onSubmit={handleContinue}>
                  <RadioGroup
                    value={reason}
                    onValueChange={(value) => {
                      setReason(value as Reason);
                      setFormError("");
                      setSubmitError("");
                    }}
                    className="unsubscribe-reasons"
                    aria-label="Причина отписки"
                  >
                    {REASONS.map((item) => (
                      <Label
                        key={item.value}
                        htmlFor={`unsubscribe-reason-${item.value}`}
                        className="unsubscribe-reason"
                      >
                        <RadioGroupItem
                          id={`unsubscribe-reason-${item.value}`}
                          value={item.value}
                          className="unsubscribe-reason__control"
                        />
                        <span className="unsubscribe-reason__text">
                          <span>{item.title}</span>
                          <small>{item.desc}</small>
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>

                  {reason === "other" ? (
                    <div className="unsubscribe-other">
                      <Label htmlFor="unsubscribe-other-reason">Причина</Label>
                      <Textarea
                        id="unsubscribe-other-reason"
                        value={otherReason}
                        onChange={(event) => {
                          setOtherReason(event.target.value);
                          setFormError("");
                          setSubmitError("");
                        }}
                        maxLength={500}
                        placeholder="Напишите коротко, почему хотите отписаться"
                        className="unsubscribe-textarea"
                      />
                    </div>
                  ) : null}

                  {formError ? (
                    <p className="unsubscribe-error" role="alert">
                      {formError}
                    </p>
                  ) : null}
                  {submitError ? (
                    <p className="unsubscribe-error" role="alert">
                      {submitError}
                    </p>
                  ) : null}

                  <Button type="submit" className="btn btn--primary btn--lg unsubscribe-submit">
                    Продолжить
                    <ArrowRight className="btn__icon" aria-hidden="true" />
                  </Button>
                </form>
              </article>
            )}
          </div>
        </section>
      </main>

      <LandingFooter />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="unsubscribe-dialog">
          <DialogHeader>
            <DialogTitle>Подтвердите отписку</DialogTitle>
            <DialogDescription>
              После подтверждения мы отключим email-рассылку для адреса из этого письма.
            </DialogDescription>
          </DialogHeader>

          <div className="unsubscribe-dialog__body">
            <div className="unsubscribe-dialog__summary">
              <span>Причина</span>
              <strong>{selectedReason?.title || "Не выбрана"}</strong>
            </div>

            <Label htmlFor="unsubscribe-consent" className="unsubscribe-consent">
              <Checkbox
                id="unsubscribe-consent"
                checked={consent}
                onCheckedChange={(checked) => {
                  setConsent(checked === true);
                  setModalError("");
                }}
              />
              <span>Я понимаю, что больше не буду получать email-рассылку 220v</span>
            </Label>

            {modalError ? (
              <p className="unsubscribe-error" role="alert">
                {modalError}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="btn btn--ghost unsubscribe-dialog__button"
              onClick={() => setConfirmOpen(false)}
              disabled={submitState === "submitting"}
            >
              Назад
            </Button>
            <Button
              type="button"
              className="btn btn--primary unsubscribe-dialog__button"
              onClick={handleConfirm}
              disabled={submitState === "submitting"}
            >
              {submitState === "submitting" ? (
                <Loader2 className="btn__icon unsubscribe-spinner" aria-hidden="true" />
              ) : null}
              Подтвердить отписку
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LandingShell>
  );
};

export default UnsubscribeEmail;
