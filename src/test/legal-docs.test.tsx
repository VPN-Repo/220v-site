import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import Policy from "@/pages/Policy";
import Terms from "@/pages/Terms";
import { OPERATOR_REQUISITES } from "@/lib/requisites";

const LEGAL_DIR = path.resolve(__dirname, "../content/legal");
const source = (name: string) => readFileSync(path.join(LEGAL_DIR, name), "utf8");

// Bullets are list markup (<li>), not words; everything else must match.
const normalize = (text: string) => text.replace(/•/g, "").replace(/\s+/g, "");

function renderPage(page: JSX.Element) {
  return render(<MemoryRouter>{page}</MemoryRouter>);
}

describe.each([
  { name: "privacy policy", Page: Policy, file: "privacy.txt" },
  { name: "terms of use", Page: Terms, file: "terms.txt" },
])("$name page", ({ Page, file }) => {
  it("renders the owner's text verbatim (whitespace-insensitive)", () => {
    const { container } = renderPage(<Page />);
    const article = container.querySelector("article.doc__content");
    expect(article).not.toBeNull();
    expect(normalize(article!.textContent ?? "")).toBe(normalize(source(file)));
  });

  it("keeps the operator line from the source and shows the requisites only in the footer", () => {
    const { container } = renderPage(<Page />);
    const article = container.querySelector("article.doc__content")!;
    expect(article.textContent).toContain('Оператор: ОсОО "Эль Торо Системс КейДжи"');
    expect(article.textContent).not.toContain("307549-3301-ООО");

    const footer = within(container.querySelector("footer")!);
    for (const line of OPERATOR_REQUISITES) expect(footer.getByText(line)).toBeInTheDocument();
  });
});

describe("legal page markup", () => {
  it("structures and links the privacy policy", () => {
    renderPage(<Policy />);
    expect(screen.getByRole("heading", { level: 1, name: "Политика конфиденциальности 220v" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "1. Общие положения" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "3.1. Права пользователей:" })).toBeInTheDocument();
    expect(screen.getByText(/Цифрового кодекса Кыргызской Республики от 31 июля 2025 года № 178/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "https://t.me/vpn220v_bot" })[0]).toHaveAttribute(
      "href",
      "https://t.me/vpn220v_bot",
    );
    expect(screen.getAllByRole("link", { name: "privacy@220vvpn.org" })[0]).toHaveAttribute(
      "href",
      "mailto:privacy@220vvpn.org",
    );
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(20);
  });

  it("structures and links the terms of use", () => {
    renderPage(<Terms />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Условия использования и Пользовательское соглашение сервиса 220v" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "5. Политика возврата средств" })).toBeInTheDocument();
    expect(screen.getByText(/2 ГБ для тестового периода и 30 ГБ в месяц/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://220v.tech/price" })).toHaveAttribute("href", "/price");
    expect(screen.getByRole("link", { name: "https://220v.tech/policy" })).toHaveAttribute("href", "/policy");
    expect(screen.getByRole("link", { name: "https://t.me/vpn220v_bot" })).toHaveAttribute(
      "href",
      "https://t.me/vpn220v_bot",
    );
    expect(screen.getByRole("link", { name: "support@220v.shop" })).toHaveAttribute("href", "mailto:support@220v.shop");
  });

  it("drops the previous operator and Russian-law references", () => {
    for (const Page of [Policy, Terms]) {
      const { container, unmount } = renderPage(<Page />);
      const text = container.textContent ?? "";
      for (const old of ["VividAxiom", "Salado", "Texas", "152-ФЗ", "149-ФЗ", "законодательству РФ"]) {
        expect(text).not.toContain(old);
      }
      unmount();
    }
  });
});
