import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BookOpen,
  CreditCard,
  Gauge,
  Gift,
  LifeBuoy,
  MoreHorizontal,
  ShoppingCart,
} from "lucide-react";
import { toast } from "sonner";

import { apiGet, apiPost } from "@/lib/api";
import { useSession } from "@/hooks/useSession";
import {
  clearChatCompatCache,
  getVpnTalkmeProfileRaw,
} from "@/lib/vpnStorage";
import { resolveIsPremium } from "@/lib/tariff";
import { useTrafficPurchaseRestriction } from "@/hooks/useTrafficPurchaseRestriction";
import type { DashboardSidebarItem } from "@/components/DashboardSidebar";

type SidebarUser = {
  userUuid: string | null;
  isPremium: boolean;
};

export const SIDEBAR_SHOW_OTHER = false;
export const SIDEBAR_SHOW_REFERRALS = true;

function readCachedIsPremium(): boolean {
  try {
    const raw = getVpnTalkmeProfileRaw();
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return resolveIsPremium(parsed);
  } catch {
    return false;
  }
}

export type DashboardSidebarData = {
  email: string | null;
  items: DashboardSidebarItem[];
  handleLogout: () => void;
  userUuid: string | null;
  userLoading: boolean;
  userError: string | null;
  trafficRestriction: string | null;
};

export function useDashboardSidebarItems(): DashboardSidebarData {
  const navigate = useNavigate();
  const { status: sessionStatus, email, user: sessionUser, refresh: refreshSession } = useSession();
  const [userInfo, setUserInfo] = useState<SidebarUser>(() => ({
    userUuid: sessionUser?.userUuid ?? null,
    isPremium: readCachedIsPremium() || resolveIsPremium(sessionUser),
  }));
  const [userLoading, setUserLoading] = useState(sessionStatus === "checking");
  const [userError, setUserError] = useState<string | null>(null);
  const [trafficUser, setTrafficUser] = useState<unknown>(null);
  const trafficRestriction = useTrafficPurchaseRestriction(trafficUser);

  useEffect(() => {
    if (sessionStatus !== "authed") return;

    let cancelled = false;
    setUserLoading(true);
    setUserError(null);
    (async () => {
      try {
        const { data, error } = await apiGet<{ user?: unknown }>("/me");
        if (cancelled) return;
        if (error) {
          setUserError(error.message ?? "Не удалось получить данные");
          return;
        }
        const user = (data as { user?: unknown } | null)?.user;
        setTrafficUser(user);
        const uuidCandidate =
          user && typeof user === "object"
            ? (user as Record<string, unknown>).userUuid
            : null;
        setUserInfo({
          userUuid: typeof uuidCandidate === "string" ? uuidCandidate : null,
          isPremium: resolveIsPremium(user),
        });
      } catch (err) {
        if (!cancelled) {
          setUserError(err instanceof Error ? err.message : "Ошибка загрузки данных");
        }
      } finally {
        if (!cancelled) setUserLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionStatus]);

  const handleLogout = async () => {
    await apiPost("/auth/logout");
    clearChatCompatCache();
    await refreshSession();
    navigate("/");
  };

  const items = useMemo<DashboardSidebarItem[]>(() => {
    const list: DashboardSidebarItem[] = [
      {
        key: "subscription",
        label: "Моя подписка",
        icon: CreditCard,
        onClick: () => navigate("/dashboard"),
        primary: true,
        match: "/dashboard",
      },
      {
        key: "tariff",
        label: "Купить тариф",
        icon: ShoppingCart,
        onClick: () => navigate("/tariff"),
        match: "/tariff",
      },
    ];

    if (userInfo.isPremium && !trafficRestriction && !userError) {
      list.push({
        key: "traffic",
        label: "Купить трафик",
        icon: Gauge,
        onClick: () => navigate("/traffic"),
        match: "/traffic",
      });
    }

    list.push(
      {
        key: "instructions",
        label: "Инструкции",
        icon: BookOpen,
        onClick: () => navigate("/instructions"),
        match: "/instructions",
      },
      {
        key: "support",
        label: "Поддержка",
        icon: LifeBuoy,
        onClick: () => navigate("/chat"),
        match: ["/support", "/chat"],
      },
      {
        key: "referrals",
        label: "Реферальная программа",
        icon: Gift,
        onClick: () => navigate("/referrals"),
        match: "/referrals",
      },
      {
        key: "other",
        label: "Другое",
        icon: MoreHorizontal,
        onClick: () => toast.info("Раздел скоро переедет на отдельную страницу"),
      },
    );

    return list.filter(
      (item) =>
        (item.key !== "other" || SIDEBAR_SHOW_OTHER) &&
        (item.key !== "referrals" || SIDEBAR_SHOW_REFERRALS),
    );
  }, [navigate, userInfo.isPremium, trafficRestriction, userError]);

  return {
    email: email || null,
    items,
    handleLogout,
    userUuid: userInfo.userUuid,
    userLoading,
    userError,
    trafficRestriction,
  };
}

export default useDashboardSidebarItems;
