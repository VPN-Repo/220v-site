import { createContext, useContext } from "react";
import type { ActivePromo } from "@/lib/promo";

export type PromoState = {
  /** Скидка, сохранённая в серверной сессии; null — скидки нет. */
  activePromo: ActivePromo | null;
  resolving: boolean;
  refreshActivePromo(): Promise<void>;
  /** Ручной ввод кода скидки. true — код сохранён. */
  resolveManualPromo(input: string): Promise<boolean>;
};

// Outside PromoProvider (isolated page tests) the pages behave as if no discount is saved.
const NO_PROMO: PromoState = {
  activePromo: null,
  resolving: false,
  refreshActivePromo: async () => {},
  resolveManualPromo: async () => false,
};

export const PromoContext = createContext<PromoState>(NO_PROMO);

export function usePromo(): PromoState {
  return useContext(PromoContext);
}
