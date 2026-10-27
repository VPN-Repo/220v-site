import { describe, expect, it } from "vitest";
import {
  cleanPromoUrl,
  isPromoUnsupportedMethod,
  parseManualPromo,
  parsePromoLink,
  pluralDays,
  promoCheckoutFields,
} from "@/lib/promo";

const saved = { kind: "sale" as const, code: "SPRING20", activated_at: "2026-10-01T00:00:00Z" };

describe("promo link parsing", () => {
  it("normalizes decoded codes and recognizes only its own parameter names", () => {
    expect(parsePromoLink("?pdays=free7days")).toEqual({ status: "valid", candidate: { kind: "days", code: "FREE7DAYS" } });
    expect(parsePromoLink("?psale=%20spring20%20")).toEqual({ status: "valid", candidate: { kind: "sale", code: "SPRING20" } });
    expect(parsePromoLink("?promo=FREE7DAYS&constructor=A")).toEqual({ status: "none" });
    expect(parsePromoLink("?psale=осень-20")).toEqual({ status: "valid", candidate: { kind: "sale", code: "ОСЕНЬ-20" } });
  });

  it.each(["?psale=A&psale=A", "?pdays=A&psale=B", "?pdays=A&pdays=B"])("rejects several codes: %s", (url) => {
    expect(parsePromoLink(url)).toEqual({ status: "invalid", error: "В ссылке больше одного промокода" });
  });

  it.each(["?psale=", "?pdays=%20", `?psale=${"x".repeat(65)}`, `?psale=${"ß".repeat(33)}`])(
    "rejects an invalid normalized value: %s",
    (url) => {
      expect(parsePromoLink(url).status).toBe("invalid");
    },
  );

  it("removes only promo parameters and keeps path, query and hash", () => {
    expect(cleanPromoUrl({ pathname: "/tariff", search: "?from=mail&psale=A&tag=x&tag=y", hash: "#pay" })).toBe(
      "/tariff?from=mail&tag=x&tag=y#pay",
    );
    expect(cleanPromoUrl({ pathname: "/", search: "?pdays=A", hash: "" })).toBe("/");
  });

  it("treats manual input as a discount code only", () => {
    expect(parseManualPromo(" spring20 ")).toEqual({ candidate: { kind: "sale", code: "SPRING20" } });
    expect(parseManualPromo(" ").error).toBe("Нужно ввести код скидки");
    for (const raw of ["https://220v.shop/?psale=A", "?psale", "psale=A", "a".repeat(65)]) {
      expect(parseManualPromo(raw).error).toBe("Нужен только код, без ссылки и параметров");
    }
  });
});

describe("promo checkout helpers", () => {
  it("blocks Tribute only while a discount is saved", () => {
    const tribute = { id: 11, type: "card", label: "Оплата картой", provider: " TRIBUTE " };
    const sbp = { id: 2, type: "sbp", label: "СБП (QR-код)", provider: "yookassa" };
    expect(isPromoUnsupportedMethod(tribute, saved)).toBe(true);
    expect(isPromoUnsupportedMethod(tribute, null)).toBe(false);
    expect(isPromoUnsupportedMethod(sbp, saved)).toBe(false);
  });

  it("asserts the saved code at checkout and sends nothing without one", () => {
    expect(promoCheckoutFields(saved)).toEqual({ expected_promo_code: "SPRING20" });
    expect(promoCheckoutFields(null)).toEqual({});
  });

  it("declines days in Russian", () => {
    expect([1, 2, 5, 11, 21, 24].map((n) => `${n} ${pluralDays(n)}`)).toEqual([
      "1 день", "2 дня", "5 дней", "11 дней", "21 день", "24 дня",
    ]);
  });
});
