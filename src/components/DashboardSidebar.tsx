import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  CreditCard,
  ShoppingCart,
  Gauge,
  BookOpen,
  LifeBuoy,
  MoreHorizontal,
  LogOut,
  ChevronDown,
  Menu as MenuIcon,
  X as CloseIcon,
} from "lucide-react";
import logo220v from "@/assets/logo-220v.webp";
import { lockDocumentScroll } from "@/lib/scrollLock";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

export type DashboardSidebarItem = {
  key: string;
  label: string;
  icon: IconType;
  onClick: () => void;
  primary?: boolean;
  /** Accent the item while it is not active, so it stands out in the menu. */
  highlight?: boolean;
  /**
   * Pathname (or list of pathnames) that should mark this item as active.
   * An item matches when the current pathname equals the value or starts
   * with `<value>/` (so `/tariff` also covers `/tariff/pay`).
   */
  match?: string | string[];
};

const isPathMatch = (
  pathname: string,
  match: DashboardSidebarItem["match"],
): boolean => {
  if (!match) return false;
  const patterns = Array.isArray(match) ? match : [match];
  return patterns.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
};

const MOBILE_TITLE_COLLAPSE_OFFSET = 8;
const MOBILE_SCROLL_SELECTOR = "[data-dashboard-mobile-scroll]";

const hasCollapsedMobileTitleScroll = () => {
  const scrollingElement = document.scrollingElement || document.documentElement;
  const pageScrollTop = window.scrollY || scrollingElement?.scrollTop || 0;

  if (pageScrollTop > MOBILE_TITLE_COLLAPSE_OFFSET) return true;

  const scrollContainers = document.querySelectorAll<HTMLElement>(MOBILE_SCROLL_SELECTOR);
  for (const container of scrollContainers) {
    if (container.scrollTop > MOBILE_TITLE_COLLAPSE_OFFSET) return true;
  }

  return false;
};

type DashboardSidebarProps = {
  items: DashboardSidebarItem[];
  onLogout: () => void;
  email?: string;
  mobileTitle?: string;
  mobileHint?: string;
};

export const DashboardSidebar = ({
  items,
  onLogout,
  email,
  mobileTitle,
  mobileHint,
}: DashboardSidebarProps) => {
  const [open, setOpen] = useState(false);
  const [mobileHintOpen, setMobileHintOpen] = useState(false);
  const [mobileTitleCollapsed, setMobileTitleCollapsed] = useState(false);
  const collapseFrameRef = useRef<number | null>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const unlockScroll = lockDocumentScroll();
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      unlockScroll();
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || typeof window.matchMedia !== "function") return;
    // The drawer only exists below 961px; close it (and release the scroll lock)
    // when a rotation or resize switches to the static desktop sidebar.
    const desktop = window.matchMedia("(min-width: 961px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    closeOnDesktop();
    desktop.addEventListener?.("change", closeOnDesktop);
    return () => desktop.removeEventListener?.("change", closeOnDesktop);
  }, [open]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileHintOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    setMobileHintOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileTitle) {
      setMobileTitleCollapsed(false);
      return;
    }

    const updateCollapsed = () => {
      collapseFrameRef.current = null;
      const collapsed = hasCollapsedMobileTitleScroll();
      setMobileTitleCollapsed((current) => (current === collapsed ? current : collapsed));
      if (collapsed) setMobileHintOpen(false);
    };

    const requestUpdate = () => {
      if (collapseFrameRef.current !== null) return;
      collapseFrameRef.current = window.requestAnimationFrame(updateCollapsed);
    };

    const scrollOptions: AddEventListenerOptions = { capture: true, passive: true };

    requestUpdate();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    document.addEventListener("scroll", requestUpdate, scrollOptions);
    window.addEventListener("resize", requestUpdate);
    window.visualViewport?.addEventListener("resize", requestUpdate);

    return () => {
      if (collapseFrameRef.current !== null) {
        window.cancelAnimationFrame(collapseFrameRef.current);
        collapseFrameRef.current = null;
      }
      window.removeEventListener("scroll", requestUpdate);
      document.removeEventListener("scroll", requestUpdate, scrollOptions);
      window.removeEventListener("resize", requestUpdate);
      window.visualViewport?.removeEventListener("resize", requestUpdate);
    };
  }, [mobileTitle, pathname]);

  const handleItem = (item: DashboardSidebarItem) => {
    setOpen(false);
    setMobileHintOpen(false);
    item.onClick();
  };

  const mobileTitleClassName = `dashboard-sidebar__mobile-title${
    mobileHintOpen ? " dashboard-sidebar__mobile-title--open" : ""
  }${mobileTitleCollapsed ? " dashboard-sidebar__mobile-title--collapsed" : ""}`;

  return (
    <>
      <button
        type="button"
        className="dashboard-sidebar__burger"
        aria-label="Открыть меню"
        aria-expanded={open}
        onClick={() => {
          setMobileHintOpen(false);
          setOpen(true);
        }}
      >
        <MenuIcon className="h-5 w-5" />
      </button>
      {mobileTitle && mobileHint ? (
        <>
          <button
            type="button"
            className={mobileTitleClassName}
            aria-expanded={mobileHintOpen && !mobileTitleCollapsed}
            aria-controls="dashboard-mobile-hint"
            aria-hidden={mobileTitleCollapsed || undefined}
            tabIndex={mobileTitleCollapsed ? -1 : undefined}
            onClick={() => setMobileHintOpen((value) => !value)}
          >
            <span>{mobileTitle}</span>
            <ChevronDown className="dashboard-sidebar__mobile-title-chevron" aria-hidden="true" />
          </button>
          {mobileHintOpen && !mobileTitleCollapsed ? (
            <div id="dashboard-mobile-hint" className="dashboard-sidebar__mobile-hint" role="status">
              {mobileHint}
            </div>
          ) : null}
        </>
      ) : mobileTitle ? (
        <div className={mobileTitleClassName} aria-hidden="true">
          {mobileTitle}
        </div>
      ) : null}

      {open ? (
        <div
          className="dashboard-sidebar__backdrop"
          aria-hidden="true"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <aside
        className={`dashboard-sidebar${open ? " dashboard-sidebar--open" : ""}`}
        aria-label="Главное меню"
      >
        <div className="dashboard-sidebar__head">
          <Link to="/" className="dashboard-sidebar__logo" aria-label="220v">
            <img
              src={logo220v}
              alt="220v"
              className="dashboard-sidebar__logo-img"
              width={1254}
              height={1254}
              decoding="async"
            />
          </Link>
          <button
            type="button"
            className="dashboard-sidebar__close"
            aria-label="Закрыть меню"
            onClick={() => setOpen(false)}
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {email ? <div className="dashboard-sidebar__email">{email}</div> : null}

        <nav className="dashboard-sidebar__nav">
          {items.map((item) => {
            const Icon = item.icon;
            const active = isPathMatch(pathname, item.match);
            const primary = item.primary && active;
            return (
              <button
                key={item.key}
                type="button"
                className={`dashboard-sidebar__link${
                  primary ? " dashboard-sidebar__link--primary" : ""
                }${active ? " dashboard-sidebar__link--active" : ""}${
                  item.highlight && !active ? " dashboard-sidebar__link--highlight" : ""
                }`}
                aria-current={active ? "page" : undefined}
                onClick={() => handleItem(item)}
              >
                <Icon className="h-5 w-5 dashboard-sidebar__link-icon" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="dashboard-sidebar__foot">
          <button
            type="button"
            className="dashboard-sidebar__link dashboard-sidebar__link--logout"
            onClick={() => {
              setOpen(false);
              setMobileHintOpen(false);
              onLogout();
            }}
          >
            <LogOut className="h-5 w-5 dashboard-sidebar__link-icon" />
            <span>Выйти</span>
          </button>
        </div>
      </aside>
    </>
  );
};

export default DashboardSidebar;
