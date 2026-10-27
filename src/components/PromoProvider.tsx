import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { apiGet, apiPost } from "@/lib/api";
import {
  PROMO_DAYS_APPLIED_EVENT,
  cleanPromoUrl,
  hasPromoLinkParams,
  parseManualPromo,
  parsePromoLink,
  pluralDays,
  type ActivePromo,
  type PromoCandidate,
} from "@/lib/promo";
import { peekVpnPendingRedirect, setVpnPendingRedirect } from "@/lib/vpnStorage";
import { PromoContext } from "@/hooks/usePromo";
import { useSession } from "@/hooks/useSession";

type ResolveResponse = {
  status: "none" | "pending_checkout_validation" | "days_applied";
  promo?: ActivePromo;
  days_added?: number;
};

const CAPTURE_FAILED = "Промокод из ссылки не сохранился. Стоит обновить страницу и попробовать снова.";
const NETWORK_FAILED = "Нет связи с сервером, промокод не обработан. Стоит повторить попытку.";

/**
 * Глобальная обработка промоссылок ?pdays= / ?psale= на любом маршруте, включая главную:
 * код уходит на сервер (HttpOnly-cookie), адрес очищается, после входа код применяется сам.
 * Пока ссылка обрабатывается, страницы не рендерятся — иначе редирект гостя на «/»
 * или чистка query на странице успели бы потерять код.
 */
export function PromoProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { status, user, refresh } = useSession();
  const identity = `${status}:${user?.userUuid ?? ""}`;
  const address = location.pathname + location.search + location.hash;
  const [activePromo, setActivePromo] = useState<ActivePromo | null>(null);
  const [resolving, setResolving] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [doneLinkAddress, setDoneLinkAddress] = useState("");
  const startedLinkAddress = useRef("");
  const resolvedIdentity = useRef("");
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef({ identity, address });
  latest.current = { identity, address };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshActivePromo = useCallback(async () => {
    const owner = latest.current.identity;
    try {
      const result = await apiGet<{ active: boolean; promo: ActivePromo | null }>("/promo/active");
      if (!mounted.current || latest.current.identity !== owner) return;
      if (result.status === 401 || result.status === 403) setActivePromo(null);
      else if (!result.error && result.data) setActivePromo(result.data.active ? result.data.promo : null);
    } catch {
      // keep the last known state on a transient network failure
    }
  }, []);

  const resolve = useCallback(
    async (candidate?: PromoCandidate, linkKind?: PromoCandidate["kind"]) => {
      const owner = latest.current.identity;
      setResolving(true);
      try {
        const result = await apiPost<ResolveResponse>(
          "/promo/resolve",
          candidate ? { kind: candidate.kind, promo_code: candidate.code } : undefined,
        );
        if (!mounted.current || latest.current.identity !== owner) return false;
        if (result.error) {
          if (result.status === 401) {
            setActivePromo(null);
            if (linkKind) {
              toast.info("Промокод сохранён и применится после входа");
              // The main page opens the login form when a redirect is pending.
              if (!peekVpnPendingRedirect()) setVpnPendingRedirect(linkKind === "sale" ? "/tariff" : "/dashboard");
            }
          } else {
            toast.error(result.status === 0 ? NETWORK_FAILED : result.error.message);
          }
          return false;
        }
        if (result.data?.status === "pending_checkout_validation") {
          const promo = result.data.promo ?? null;
          setActivePromo(promo);
          toast.success(
            promo ? `Скидка по промокоду ${promo.code} будет учтена при оплате` : "Скидка будет учтена при оплате",
          );
          const path = latest.current.address.split(/[?#]/)[0];
          if (!/^\/(tariff|traffic)(\/|$)/.test(path)) navigate("/tariff", { replace: true });
          return true;
        }
        if (result.data?.status === "days_applied") {
          setActivePromo(null);
          const days = Number(result.data.days_added) || 0;
          toast.success(days > 0 ? `Промокод применён: добавлено ${days} ${pluralDays(days)}` : "Промокод применён");
          window.dispatchEvent(new Event(PROMO_DAYS_APPLIED_EVENT));
          await refresh();
          return true;
        }
        return false;
      } catch {
        toast.error(NETWORK_FAILED);
        return false;
      } finally {
        if (mounted.current) setResolving(false);
        await refreshActivePromo();
      }
    },
    [navigate, refresh, refreshActivePromo],
  );

  useEffect(() => {
    if (status === "guest") setActivePromo(null);
    if (status === "checking") return;
    const parsed = parsePromoLink(location.search);
    const hasLink = parsed.status !== "none";
    if (hasLink) {
      if (startedLinkAddress.current === address) return;
      startedLinkAddress.current = address;
    } else if (resolvedIdentity.current === identity) {
      // Without a new link the pending cookie can only matter after the login state changes.
      return;
    }
    resolvedIdentity.current = identity;
    if (hasLink) setLinkBusy(true);

    const run = async () => {
      try {
        if (parsed.status === "valid") {
          const captured = await apiPost("/promo/capture", {
            kind: parsed.candidate.kind,
            promo_code: parsed.candidate.code,
          });
          // On failure the link stays in the address so a reload can retry it.
          if (captured.error) {
            toast.error(CAPTURE_FAILED);
            return;
          }
        }
        if (hasLink && latest.current.address === address) {
          navigate(cleanPromoUrl(location), { replace: true });
        }
        if (parsed.status === "invalid") {
          toast.error(parsed.error);
          await refreshActivePromo();
          return;
        }
        if (status === "guest" && parsed.status !== "valid") {
          await refreshActivePromo();
          return;
        }
        await resolve(undefined, parsed.status === "valid" ? parsed.candidate.kind : undefined);
      } catch {
        toast.error(CAPTURE_FAILED);
      } finally {
        if (mounted.current && hasLink) {
          setDoneLinkAddress(address);
          setLinkBusy(false);
        }
      }
    };
    queue.current = queue.current.then(run, run);
  }, [address, identity, location, navigate, refreshActivePromo, resolve, status]);

  const resolveManualPromo = useCallback(
    async (input: string) => {
      const parsed = parseManualPromo(input);
      if (parsed.error) {
        toast.error(parsed.error);
        return false;
      }
      const task = () => resolve(parsed.candidate);
      const result = queue.current.then(task, task);
      queue.current = result;
      return result;
    },
    [resolve],
  );

  const value = useMemo(
    () => ({ activePromo, resolving, refreshActivePromo, resolveManualPromo }),
    [activePromo, resolving, refreshActivePromo, resolveManualPromo],
  );
  const holdPages = linkBusy || (hasPromoLinkParams(location.search) && doneLinkAddress !== address);

  return (
    <PromoContext.Provider value={value}>
      {holdPages ? (
        <div className="flex min-h-[100svh] min-h-[100dvh] items-center justify-center bg-background">
          <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" aria-label="Обработка промокода" />
        </div>
      ) : (
        children
      )}
    </PromoContext.Provider>
  );
}
