/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_SITE_NAME?: string;
  readonly VITE_TARIFF_PRICE_SUB_1M?: string;
  readonly VITE_TARIFF_PRICE_SUB_6M?: string;
  readonly VITE_TARIFF_PRICE_SUB_12M?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
