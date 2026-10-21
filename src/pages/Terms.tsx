import { Link } from "react-router-dom";

import LandingShell from "@/pages/landing/LandingShell";
import LandingHeader from "@/pages/landing/LandingHeader";
import LandingFooter from "@/pages/landing/LandingFooter";
import LegalDocument from "@/pages/landing/LegalDocument";
import termsText from "@/content/legal/terms.txt?raw";

const Terms = () => (
  <LandingShell>
    <LandingHeader
      nav={
        <Link to="/" className="nav__link">
          Главная
        </Link>
      }
      cta={
        <Link to="/" className="btn btn--ghost">
          На главную
        </Link>
      }
    />

    <main>
      <section className="doc">
        <div className="container">
          <Link to="/" className="doc__back" aria-label="Назад на главную">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M15 6l-6 6 6 6"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            На главную
          </Link>

          <LegalDocument source={termsText} />
        </div>
      </section>
    </main>

    <LandingFooter />
  </LandingShell>
);

export default Terms;
