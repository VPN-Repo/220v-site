import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";

import { openSupportChat, prepareSupportChat } from "@/lib/supportChat";

type ChatwootSupportCardProps = {
  /** Logged-in user's email; identity and profile attributes are attached to the chat. */
  email: string | null;
};

/**
 * Support card for the Chatwoot website widget: the widget is loaded in the background
 * and opens only by the button (no auto-open, so the email block stays visible).
 */
export default function ChatwootSupportCard({ email }: ChatwootSupportCardProps) {
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    prepareSupportChat({ email });
  }, [email]);

  const handleOpen = () => {
    setUnavailable(!openSupportChat({ email }));
  };

  return (
    <section className="support-card support-chatwoot" aria-label="Онлайн-чат с поддержкой">
      <h2 className="support-card__title">Онлайн-чат</h2>
      <p className="support-card__subtitle">
        Поможем с оплатой, подпиской и подключением. Чат откроется в окне справа внизу, история переписки сохранится.
      </p>
      <div className="support-chatwoot__actions">
        <button type="button" className="btn btn--primary" onClick={handleOpen}>
          <MessageSquare size={18} aria-hidden="true" />
          Открыть чат
        </button>
      </div>
      {unavailable ? (
        <p className="support-chatwoot__error" role="alert">
          Не удалось загрузить чат. Напишите нам на support@220v.shop.
        </p>
      ) : null}
    </section>
  );
}
