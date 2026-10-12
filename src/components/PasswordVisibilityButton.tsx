import { Eye, EyeOff } from "lucide-react";

type Props = {
  visible: boolean;
  onClick: () => void;
  disabled?: boolean;
};

/** Кнопка «показать/скрыть пароль» внутри поля (родителю нужен `position: relative`). */
export default function PasswordVisibilityButton({ visible, onClick, disabled }: Props) {
  return (
    <button
      type="button"
      aria-label={visible ? "Скрыть пароль" : "Показать пароль"}
      aria-pressed={visible}
      className="password-toggle"
      onClick={onClick}
      disabled={disabled}
    >
      {visible ? <EyeOff aria-hidden="true" size={20} /> : <Eye aria-hidden="true" size={20} />}
    </button>
  );
}
