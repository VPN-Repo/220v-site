/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_SITE_NAME?: string;
  readonly VITE_TARIFF_PRICE_SUB_1M?: string;
  readonly VITE_TARIFF_PRICE_SUB_6M?: string;
  readonly VITE_TARIFF_PRICE_SUB_12M?: string;
  /** Chatwoot installation URL, e.g. https://chat.example.com. With the token set, Chatwoot replaces Talk-Me. */
  readonly VITE_CHATWOOT_BASE_URL?: string;
  /** Website inbox token of the 220v Chatwoot inbox. */
  readonly VITE_CHATWOOT_WEBSITE_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
