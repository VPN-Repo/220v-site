# Промокоды и промоссылки 220v

Перенос механизма промоссылок с сайта Leto (коммиты b4bb1ea, ad6a520, cfa5b13) на структуру 220v.
Начисление дней, размер скидки и одноразовость кода решает RMW; на сайте нет каталога промокодов
и расчёта скидок.

## Как собрать ссылку

Параметр работает на любой странице сайта, включая главную:

- `https://220v.shop/?pdays=CODE` — бонусные дни: код применяется через RMW `POST /v1/billing/promo-code/apply`.
- `https://220v.shop/?psale=CODE` — скидка: код сохраняется в серверной сессии и уходит в RMW как `promo_code`
  со следующим `POST /v1/billing/checkout` (тариф или пакет LTE-трафика).

Можно вести сразу на нужную страницу и с другими параметрами, например `https://220v.shop/tariff?psale=CODE&utm_source=tg`.
Код нечувствителен к регистру, до 64 символов; в ссылке должен быть ровно один из `pdays` / `psale`.
Старые ссылки `?promo=CODE` (бонусные дни через `/api/me/promo-code/apply`) продолжают работать как раньше.

## Поведение

1. `PromoProvider` видит `pdays`/`psale`, отправляет код в `POST /api/promo/capture` — сервер кладёт его
   в HttpOnly-cookie `v220_promo_pending` (SameSite=Lax, 7 дней). Пока ссылка обрабатывается, страницы
   не рендерятся, чтобы редирект гостя или чистка query не потеряли код.
2. Параметр удаляется из адреса (`replace`), остальной query и hash остаются. Если сохранить код не удалось,
   ссылка остаётся в адресе для повтора. Ссылка с несколькими кодами или пустым кодом только очищается.
3. `POST /api/promo/resolve` применяет код из cookie. Гость видит «Промокод сохранён и применится после входа»,
   и на главной открывается вход; после входа код применяется автоматически, без перехода по ссылке снова.
4. Дни: тост «Промокод применён: добавлено N дней», профиль и кабинет перечитываются
   (событие `v220:promo-days-applied`). Прежняя сохранённая скидка при этом снимается.
5. Скидка: тост «Скидка по промокоду CODE будет учтена при оплате», открывается `/tariff`
   (если ссылка открыта на `/tariff*` или `/traffic*`, страница не меняется). Новый код заменяет предыдущий.
   На экранах оплаты (`/tariff/pay`, `/traffic/pay`, докупка трафика в кабинете) показывается плашка с кодом
   и цена без скидки — итог считает RMW при создании платежа.
6. Ручной ввод: в кабинете «Другое → Промокод» есть переключатель «Бонусные дни» (прежняя форма,
   `/api/me/promo-code/apply`) и «Скидка на оплату» (`/api/promo/resolve` с `kind: "sale"`).

## Checkout

- Браузер передаёт `expected_promo_code` — код, который он показывает. Если в сессии другого кода нет,
  ответ `409 promo_not_saved` и платёж по полной цене не создаётся. В RMW код идёт только из сессии;
  клиентские `promo_code`, `user_ref`, цена игнорируются.
- Провайдер способа оплаты берётся из `/v1/payments/methods` (поле `provider`, по `id`; список может быть
  обёрнут в `items`). С промокодом Tribute запрещён (`409 promo_provider_unsupported`, кнопка выключена),
  а при неизвестном провайдере оплата с промокодом останавливается (`409 promo_provider_unknown`).
  Способы с `active`/`is_active` равными false/0 скрываются.
- Ошибки RMW `promo code is invalid or unavailable` / `unsupported promo discount type` снимают код
  (`promo_code_invalid`); `payment amount must be greater than zero` код сохраняет (`promo_not_applicable`).
- После checkout сайт читает `GET /v1/billing/transactions/{transaction_id}` и отдаёт ссылку на оплату,
  только если совпадают id, URL, продукт, способ оплаты и код, а `original_amount` меньше базовой цены
  из `/v1/products/list`. Иначе `promo_unverified` и переход к оплате останавливается (платёж в RMW
  уже может существовать). Код снимается из сессии после успешной проверки, до самой оплаты;
  отмена оплаты его не возвращает.

## Защита

- Capture доступен гостям: только `Sec-Fetch-Site` same-origin/none и `Origin`, совпадающий с `Host`
  или в точности с origin из `PUBLIC_SITE_URL` (на случай прокси, подменяющего Host). `X-Forwarded-Host`
  не учитывается. Без `Origin` в production запрос отклоняется. Лимит — 120 захватов в час на IP.
- Redis-lock на сессию и 60-секундный кэш результата дней гасят двойные запросы; однократность между
  сессиями обеспечивает RMW. Поле `activePromo` в сессии меняется атомарно (Lua compare-and-set),
  TTL и прочие поля сохраняются. Logout и истёкшая сессия удаляют `v220_promo_pending`.

## Файлы

- `api/promo.mjs` — capture / resolve / active, cookie, lock и кэш дней, проверка Origin.
- `api/auth/session.mjs` — `activePromo` в `req.session`, `updateSessionPromo`, очистка cookie при выходе.
- `api/index.mjs` — общий вызов RMW apply (`requestRmwPromoApply`), провайдеры способов оплаты, checkout
  с промокодом и `verifyPromoPayment`.
- `api/http/rateLimit.mjs` (`promoCaptureIpLimiter`), `api/config.mjs` (`PROMO_PENDING_COOKIE`), `api/Dockerfile`.
- `src/lib/promo.ts`, `src/hooks/usePromo.ts`, `src/components/PromoProvider.tsx`,
  `src/components/PromoCheckoutNotice.tsx`, `src/App.tsx`.
- `src/pages/TariffPay.tsx`, `src/pages/TrafficPay.tsx`, `src/pages/Dashboard.tsx`, `src/pages/landing.css`.
- Тесты: `api/test/promo.integration.test.mjs`, `src/test/promo.test.ts`, `src/test/promo-provider.test.tsx`.

## Развёртывание

Новых переменных нет. Нужны существующие `RMW_API_URL`, `RMW_API_KEY`, `REDIS_URL`, `BILLING_ALLOWED_HOSTS`
и `PUBLIC_SITE_URL=https://220v.shop` (точный публичный origin: схема, хост, без пути). Проверка цепочки
прокси без применения кода: пустой `POST /api/promo/capture` с `Origin: https://220v.shop` должен вернуть
`400 invalid_promo`, а не `403 invalid_origin`.

Реальные начисления и платежи не проверялись: тесты подменяют RMW и Redis (ioredis-mock). Поддержку
`promo_code` в checkout, `/v1/payments/methods` и `/v1/billing/transactions/{id}` у развёрнутого RMW 220v
нужно подтвердить на тестовом окружении с тестовыми кодами.
