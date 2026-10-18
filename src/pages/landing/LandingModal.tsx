import { useEffect, useId, useRef, type ReactNode } from "react";

import { lockDocumentScroll } from "@/lib/scrollLock";

type LandingModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  wide?: boolean;
  children: ReactNode;
};

export const LandingModal = ({ open, onClose, title, subtitle, wide, children }: LandingModalProps) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const unlockScroll = lockDocumentScroll();
    const prevActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    window.requestAnimationFrame(() => {
      const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      firstFocusable?.focus();
    });
    return () => {
      unlockScroll();
      document.removeEventListener("keydown", onKey);
      prevActiveElement?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal__backdrop" onClick={onClose} />
      <div ref={dialogRef} className={`modal__dialog${wide ? " modal__dialog--wide" : ""}`} role="document">
        <button type="button" className="modal__close" aria-label="Закрыть" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h2 id={titleId} className="modal__title">{title}</h2>
        {subtitle ? <p className="modal__subtitle">{subtitle}</p> : null}
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
};

export default LandingModal;
