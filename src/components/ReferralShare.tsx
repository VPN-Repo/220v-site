import { useRef, useState } from "react";
import { Check, Copy, MessageCircle, Send, Share2 } from "lucide-react";
import { toast } from "sonner";

import { copyText } from "@/lib/clipboard";
import {
  canNativeShare,
  nativeShareReferral,
  referralShareTargets,
  referralShareText,
  type ReferralShareTarget,
} from "@/lib/referralPromo";

const TARGET_ICONS: Record<ReferralShareTarget["key"], typeof Send | null> = {
  telegram: Send,
  whatsapp: MessageCircle,
  vk: null,
};

type ReferralShareProps = {
  link: string;
  /** Show the link itself above the buttons (the referral page does, the pay page does not). */
  showLink?: boolean;
  className?: string;
};

/**
 * Copy button plus one-tap share targets for a referral link. The native share
 * sheet appears only where the browser supports it; otherwise "Поделиться"
 * copies the ready message so it can be pasted anywhere.
 */
const ReferralShare = ({ link, showLink = false, className = "" }: ReferralShareProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const nativeShare = canNativeShare();

  const copy = async (text: string, successMessage: string) => {
    const ok = await copyText(text, rootRef.current);
    if (ok) {
      toast.success(successMessage);
      return true;
    }
    toast.error("Не удалось скопировать. Скопируйте вручную:", { description: text, duration: 8000 });
    return false;
  };

  const handleCopyLink = async () => {
    if (await copy(link, "Ссылка скопирована!")) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleShare = async () => {
    const result = await nativeShareReferral(link);
    if (result === "unsupported") {
      await copy(referralShareText(link), "Текст со ссылкой скопирован — отправьте его другу");
    }
  };

  return (
    <div ref={rootRef} className={`ref-share ${className}`.trim()} data-testid="referral-share">
      {showLink ? (
        <div className="ref-share__link">
          <span className="ref-share__url" title={link}>
            {link}
          </span>
        </div>
      ) : null}

      <div className="ref-share__main">
        <button type="button" className="ref-share__copy" onClick={() => void handleCopyLink()}>
          {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          {copied ? "Скопировано" : "Скопировать ссылку"}
        </button>
        <button type="button" className="ref-share__share" onClick={() => void handleShare()}>
          <Share2 className="h-4 w-4" aria-hidden="true" />
          Поделиться
        </button>
      </div>

      <div className="ref-share__targets" aria-label="Отправить ссылку">
        {referralShareTargets(link).map((target) => {
          const Icon = TARGET_ICONS[target.key];
          return (
            <a
              key={target.key}
              href={target.href}
              target="_blank"
              rel="noopener noreferrer"
              className={`ref-share__target ref-share__target--${target.key}`}
            >
              {Icon ? <Icon className="h-4 w-4" aria-hidden="true" /> : null}
              <span>{target.label}</span>
            </a>
          );
        })}
      </div>
      {nativeShare ? null : (
        <p className="ref-share__hint">«Поделиться» скопирует готовый текст со ссылкой</p>
      )}
    </div>
  );
};

export default ReferralShare;
