export type BillingPaymentMethod = {
  id: number;
  type: string;
  label: string;
  /** Платёжный провайдер из RMW в нижнем регистре, например "tribute". */
  provider?: string;
};
