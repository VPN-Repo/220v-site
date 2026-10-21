import React, { useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";

type SubscriptionQrProps = {
  /** The exact value to encode — the Happ meta link from `happSubscriptionLink()`. */
  value: string;
  /** Accessible name of the code, read out like an image alt text. */
  alt?: string;
  className?: string;
  size?: number;
};

/**
 * Renders the subscription QR locally in the browser (no third-party service
 * ever sees the link). Error correction M, a 4-module quiet zone, dark on white.
 * If the code cannot be built (for example the value is too long), it falls back
 * to the link itself with a copy button.
 */
const SubscriptionQr = ({ value, alt = "QR-Code", className = "h-52 w-52", size = 220 }: SubscriptionQrProps) => (
  <QrErrorBoundary fallback={<QrFallback value={value} />} resetKey={value}>
    <QRCodeSVG
      value={value}
      size={size}
      level="M"
      marginSize={4}
      bgColor="#FFFFFF"
      fgColor="#000000"
      className={className}
      role="img"
      aria-label={alt}
    />
  </QrErrorBoundary>
);

const QrFallback = ({ value }: { value: string }) => {
  const btnRef = useRef<HTMLButtonElement>(null);
  const handleCopy = () => {
    void copyText(value, btnRef.current).then((ok) => {
      if (ok) toast.success("Ссылка скопирована!");
      else toast.error("Не удалось скопировать. Скопируйте вручную.");
    });
  };
  return (
    <div className="flex w-52 flex-col items-center gap-2 text-center text-sm text-black" role="alert">
      <p>Не удалось построить QR-код. Скопируйте ссылку и добавьте её в Happ вручную:</p>
      <input
        readOnly
        value={value}
        aria-label="Ссылка подписки"
        className="w-full rounded border border-neutral-300 px-2 py-1 text-xs"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button ref={btnRef} type="button" className="dash-modal-btn dash-modal-btn--ghost" onClick={handleCopy}>
        Скопировать ссылку
      </button>
    </div>
  );
};

type BoundaryProps = { fallback: React.ReactNode; resetKey: string; children: React.ReactNode };
type BoundaryState = { failed: boolean; key: string };

class QrErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default SubscriptionQr;
