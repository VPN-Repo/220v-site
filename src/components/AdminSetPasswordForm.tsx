import { useState } from "react";
import { KeyRound, Loader2, ShieldAlert, Wand2 } from "lucide-react";
import { apiBase } from "@/lib/api";
import { formatUserError } from "@/lib/errorMessages";
import { Button } from "@/components/ui/button";
import PasswordVisibilityButton from "@/components/PasswordVisibilityButton";
import { isValidNewPassword, PASSWORD_REQUIREMENTS } from "@/lib/password";

const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generatePassword(length = 12): string {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  const password = Array.from(bytes, (n) => PASSWORD_ALPHABET[n % PASSWORD_ALPHABET.length]).join("");
  return isValidNewPassword(password) ? password : generatePassword(length);
}

const inputClass =
  "h-10 w-full rounded-lg border border-border bg-background px-3 text-base outline-none focus:ring-2 focus:ring-ring md:text-sm";

/** Поддержка задаёт пароль существующему аккаунту, владелец которого не может получить код на почту. */
export default function AdminSetPasswordForm({ token }: { token: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ email: string; password: string } | null>(null);

  const submit = async () => {
    setError("");
    setDone(null);
    const trimmedToken = token.trim();
    const normalizedEmail = email.trim().toLowerCase();
    if (!trimmedToken) return setError("Введите ADMIN_REDIS_TOKEN");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return setError("Укажите корректный email");
    if (!isValidNewPassword(password)) return setError(PASSWORD_REQUIREMENTS);
    if (
      !window.confirm(
        `Установить новый пароль для ${normalizedEmail}? Все активные сеансы пользователя будут завершены.`,
      )
    ) {
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/admin/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": trimmedToken },
        credentials: "include",
        body: JSON.stringify({ email: normalizedEmail, password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body && typeof body.error === "string" ? body.error : `Ошибка ${res.status}`);
      }
      setDone({ email: normalizedEmail, password });
      setPassword("");
      setShowPassword(false);
    } catch (err) {
      setError(formatUserError(err, "Не удалось установить пароль"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-2xl bg-card p-4 ring-1 ring-border">
      <div className="mb-2 flex items-center gap-2 text-primary">
        <KeyRound className="h-5 w-5" />
        <h2 className="text-lg font-bold text-foreground">Установить пароль пользователю</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Для пользователей с существующим аккаунтом, которые не могут получить код на почту. Перед установкой
        убедитесь, что обращается владелец аккаунта. Старый пароль и все сеансы пользователя перестанут действовать.
      </p>
      <form
        className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (!loading) void submit();
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Email пользователя"
          aria-label="Email пользователя"
          autoComplete="off"
          className={inputClass}
          disabled={loading}
        />
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Новый пароль"
              aria-label="Новый пароль"
              autoComplete="new-password"
              className={`${inputClass} pr-12`}
              disabled={loading}
            />
            <PasswordVisibilityButton
              visible={showPassword}
              onClick={() => setShowPassword(!showPassword)}
              disabled={loading}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            disabled={loading}
            onClick={() => {
              setPassword(generatePassword());
              setShowPassword(true);
            }}
          >
            <Wand2 className="h-4 w-4" /> Сгенерировать
          </Button>
        </div>
        <Button type="submit" disabled={loading} className="gap-2">
          {loading && <Loader2 className="h-4 w-4 animate-spin" />} Установить пароль
        </Button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">{PASSWORD_REQUIREMENTS}</p>
      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <ShieldAlert className="h-4 w-4" /> {error}
        </div>
      )}
      {done && (
        <div className="mt-3 rounded-lg bg-primary/10 p-3 text-sm text-foreground">
          Пароль для <strong className="break-all">{done.email}</strong> установлен:{" "}
          <code className="select-all rounded bg-card px-1.5 py-0.5 font-mono font-semibold text-foreground ring-1 ring-border">{done.password}</code>. Передайте
          его пользователю — он входит с этим паролем.
        </div>
      )}
    </section>
  );
}
