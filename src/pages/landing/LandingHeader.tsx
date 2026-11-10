import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import logo220v from "@/assets/logo-220v.webp";

type LandingHeaderProps = {
  /** Optional nav links/buttons rendered between logo and CTA. */
  nav?: ReactNode;
  /** Optional CTA on the right (defaults to "Войти" link to /). */
  cta?: ReactNode;
  /** Optional button shown next to the burger on phones, outside the collapsed menu. */
  mobileCta?: ReactNode;
};

export const LandingHeader = ({ nav, cta, mobileCta }: LandingHeaderProps) => {
  const [open, setOpen] = useState(false);

  return (
    <header className="header">
      <div className="container header__inner">
        <Link to="/" className="logo" aria-label="220v">
          <img src={logo220v} alt="220v" className="logo__img" width={1254} height={1254} decoding="async" />
        </Link>

        <nav
          className={`nav${open ? " nav--open" : ""}`}
          aria-label="Главное меню"
          onClick={(e) => {
            if (e.target === e.currentTarget) return;
            setOpen(false);
          }}
        >
          {nav}
          <div className="header__nav-cta">
            {cta ?? (
              <Link to="/" className="btn btn--ghost">
                Войти
              </Link>
            )}
          </div>
        </nav>

        {mobileCta ? <div className="header__mobile-cta">{mobileCta}</div> : null}

        <button
          type="button"
          className="burger"
          aria-label="Меню"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
      </div>
    </header>
  );
};

export default LandingHeader;
