import { useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Copy, RefreshCw } from "lucide-react";
import { apiPost } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type RevokeSubscriptionResponse = {
  ok?: boolean;
  subscriptionUrl?: string | null;
  user?: unknown;
  message?: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Вызывается после успешного обновления: свежий профиль (если загрузился) и новая ссылка. */
  onRevoked: (result: { user: unknown; subscriptionUrl: string }) => void | Promise<void>;
};

export const REVOKE_ACTION_LABEL = "Обновить ссылку подключения";

/**
 * Выпуск новой ссылки подключения: старая перестаёт работать на всех устройствах.
 * HWID-устройства при этом из списка не удаляются (RMW вызывает только revoke в Remnawave).
 */
export default function RevokeSubscriptionDialog({ open, onOpenChange, onRevoked }: Props) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [notice, setNotice] = useState("");
  const copyButtonRef = useRef<HTMLButtonElement>(null);

  const close = (next: boolean) => {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (loading) return;
    setDone(false);
    setNewUrl("");
    setNotice("");
    onOpenChange(false);
  };

  const revoke = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const { data, error } = await apiPost<RevokeSubscriptionResponse>("/me/subscription/revoke");
      if (error) {
        toast.error(error.message || "Не удалось обновить ссылку подключения. Попробуйте ещё раз.");
        return;
      }
      const url = typeof data?.subscriptionUrl === "string" ? data.subscriptionUrl.trim() : "";
      setNewUrl(url);
      setNotice(url ? "" : data?.message || "Ссылка обновлена. Обновите страницу, чтобы увидеть новую ссылку.");
      setDone(true);
      toast.success("Ссылка подключения обновлена", {
        description: "Старая ссылка больше не работает. Подключите устройства по новой.",
      });
      try {
        await onRevoked({ user: data?.user ?? null, subscriptionUrl: url });
      } catch {
        // профиль обновится при следующей загрузке страницы
      }
    } finally {
      setLoading(false);
    }
  };

  const copyNewUrl = () => {
    if (!newUrl) return;
    void copyText(newUrl, copyButtonRef.current).then((ok) => {
      if (ok) {
        toast.success("Новая ссылка скопирована");
      } else {
        toast.error("Не удалось скопировать. Скопируйте ссылку из поля вручную.");
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="dash-modal max-h-[85dvh] overflow-y-auto sm:max-w-md">
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle>Ссылка обновлена</DialogTitle>
              <DialogDescription>
                Старая ссылка больше не работает. Вставьте новую ссылку в приложение на каждом устройстве.
              </DialogDescription>
            </DialogHeader>
            <div className="dash-modal__stack">
              <div className="dash-modal__result dash-modal__result--success">
                <div className="dash-modal__result-icon" aria-hidden="true">
                  <CheckCircle2 className="h-5 w-5" />
                </div>
                <p className="dash-modal__result-text">
                  {newUrl ? "Ваша новая ссылка подключения:" : notice}
                </p>
              </div>
              {newUrl ? (
                <>
                  <input
                    type="text"
                    readOnly
                    value={newUrl}
                    aria-label="Новая ссылка подключения"
                    className="dash-modal__input"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    ref={copyButtonRef}
                    type="button"
                    className="dash-modal-btn dash-modal-btn--primary"
                    onClick={copyNewUrl}
                  >
                    <Copy className="h-5 w-5" aria-hidden="true" />
                    Скопировать ссылку
                  </button>
                </>
              ) : null}
              <button type="button" className="dash-modal-btn dash-modal-btn--ghost" onClick={() => close(false)}>
                Готово
              </button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Обновить ссылку подключения?</DialogTitle>
              <DialogDescription>
                Сделайте это, если ссылка попала к посторонним или кто-то чужой пользуется вашей подпиской.
              </DialogDescription>
            </DialogHeader>
            <ul className="dash-modal__list">
              <li>
                <strong>Старая ссылка перестанет работать</strong> сразу на всех устройствах — VPN на них отключится.
              </li>
              <li>
                <strong>Каждое своё устройство нужно подключить заново:</strong> вставьте новую ссылку в приложение ещё
                раз.
              </li>
              <li>
                Список устройств не очищается. Если в нём есть чужие устройства, удалите их в «Управлять устройствами»,
                чтобы освободить места.
              </li>
            </ul>
            <div className="dash-modal__stack dash-modal__actions">
              <button
                type="button"
                className="dash-modal-btn dash-modal-btn--danger"
                disabled={loading}
                onClick={() => void revoke()}
              >
                <RefreshCw className={`h-5 w-5${loading ? " animate-spin" : ""}`} aria-hidden="true" />
                {loading ? "Обновляем..." : "Обновить ссылку"}
              </button>
              <button
                type="button"
                className="dash-modal-btn dash-modal-btn--ghost"
                disabled={loading}
                onClick={() => close(false)}
              >
                Отмена
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
