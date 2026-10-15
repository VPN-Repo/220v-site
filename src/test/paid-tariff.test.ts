import { describe, expect, it } from "vitest";
import { isPaidTariff, resolveIsPremium } from "@/lib/tariff";

const future = new Date(Date.now() + 10 * 864e5).toISOString();
const past = new Date(Date.now() - 864e5).toISOString();

describe("paid tariff detection", () => {
  it.each(["basic_1m", "basic_6m", "pro_6m", "premium_12m", "1month", "6month", "12month"])(
    "treats tariff %s as paid",
    (tariff) => {
      expect(isPaidTariff(tariff, "")).toBe(true);
    },
  );

  it.each(["Базовый — 1 месяц", "Pro — 6 месяцев", "Premium — 12 месяцев", "1 Месяц"])(
    "treats plan label %s as paid",
    (plan) => {
      expect(isPaidTariff("", plan)).toBe(true);
    },
  );

  it("does not treat trial as paid", () => {
    expect(isPaidTariff("trial", "Тестовый")).toBe(false);
    expect(isPaidTariff("", "")).toBe(false);
  });

  it("requires an active subscription for premium", () => {
    expect(resolveIsPremium({ tariff: "basic_1m", plan: "Базовый — 1 месяц", expireAt: future })).toBe(true);
    expect(resolveIsPremium({ tariff: "basic_1m", plan: "Базовый — 1 месяц", expireAt: past })).toBe(false);
  });
});
