# 220v — Access Gate Connect

Веб-приложение для управления VPN-подписками: авторизация по email, покупка тарифов, управление устройствами.

## Технологии

- **Frontend:** Vite + React + TypeScript + shadcn-ui + Tailwind CSS
- **Backend (API):** Node.js + Express (`api/index.mjs`)
- **VPN-панель:** [Remnawave](https://docs.rw) (`REMNAWAVE_URL`) — чтение профиля, устройства, ссылки подписки
- **RMW:** вход в дашборд (`POST /v1/auth/session`) и оплата (`POST /v1/billing/checkout`); применение тарифа и webhook платёжного провайдера выполняются на стороне RMW
- **Сессии / OTP:** Redis + AWS SES SMTP
- **Деплой:** Docker Compose (redis + api + nginx)

## Запуск

```sh
cp .env.example .env   # заполнить переменные
docker compose up -d --build
# Фронтенд: http://localhost:9080
# API внутри Docker-сети: api:3001 (проксируется через nginx /api/*)
```

## Переменные окружения (.env)

| Переменная | Описание |
|---|---|
| `REDIS_PASSWORD` / `REDIS_URL` | Redis для сессий, OTP и rate-limit |
| `SES_SMTP_*` / `MAIL_FROM_*` | Отправка OTP через AWS SES |
| `ADMIN_REDIS_TOKEN` | Токен для `/admin/redis` |
| `ADMIN_BASIC_USER` / `ADMIN_BASIC_PASSWORD` | Basic Auth nginx для админки |
| `IP_HASH_SECRET` | Секретная соль для хэшей IP/UA/fingerprint в реферальной аналитике; обязательна в production |
| `REMNAWAVE_URL` | URL панели Remnawave |
| `REMNAWAVE_TOKEN` | API-токен Remnawave (роль API) |
| `RMW_API_URL` | Базовый URL сервиса RMW (без завершающего `/`) |
| `RMW_API_KEY` | Ключ `X-Api-Key` для RMW |
| `EMAIL_UNSUBSCRIBE_SECRET` | Секрет проверки ссылок `/unsubscribe-email?t=...`; должен совпадать с `EMAIL_UNSUBSCRIBE_SECRET` в RMW |
| `NOTICE` | Опционально: текст важного объявления на `/support`; если задан, `GET {RMW_API_URL}/announcement` не вызывается |
| `PUBLIC_SITE_URL` | HTTPS origin сайта для редиректов после оплаты (пути `/pay/success` и `/pay/fail`) |
| `BILLING_SUCCESS_URL` | Опционально: явный URL успеха (https), вместе с `BILLING_CANCEL_URL` |
| `BILLING_CANCEL_URL` | Опционально: явный URL отмены (https) |
| `MAX_DEVICES` | Лимит устройств на пользователя (если задан) |

---

## Вход в дашборд (сессия через RMW)

После `POST /api/auth/verify` BFF создаёт cookie-сессию (`v220_sid` / `v220_csrf`) и загружает профиль через **RMW**:

`POST {RMW_API_URL}/v1/auth/session`  
Заголовки: `Content-Type: application/json`, `X-Api-Key: RMW_API_KEY`  
Тело: `{ "email": "user@example.com" }`

**Ответ RMW** может быть:

1. Уже в формате дашборда: `{ "exists": true|false, "user": { "plan", "userUuid", "expireAt", … } }` — отдаётся клиенту как есть.
2. В формате панели: например `{ "response": [ { …user c uuid, expireAt, userTraffic… } ] }` или объект пользователя с `uuid` — BFF собирает тот же `{ exists, user }` через `buildUserResponse`.

Число устройств (`currentDevices`) всегда подставляется из **RMW**: `GET {RMW_API_URL}/v1/hwid/devices/{userUuid}` с `X-Api-Key`. Список устройств в дашборде (`action: get-devices`) использует тот же эндпоинт, если заданы `RMW_API_URL` и `RMW_API_KEY`.

Если заданы `REMNAWAVE_URL` и `REMNAWAVE_TOKEN`, дополнительно подтягивается ссылка подписки с панели (`GET /api/subscriptions/by-uuid/...`), как раньше.

---

## Оплата (checkout через RMW)

### Схема

```
Пользователь (Dashboard)
       │
       ▼
  ┌──────────────────────┐       ┌─────────────────────┐
  │ POST /api/checkout    │──────▶│ RMW                 │
  │ (cookie + CSRF)       │       │ POST /v1/billing/   │
  │ (BFF, X-Api-Key       │       │ checkout            │
  │  к RMW на сервере)    │◀──────│ + Idempotency-Key   │
  └──────────────────────┘       └─────────────────────┘
       │  payment_url                    │
       ▼                                 │ webhook провайдера
  Браузер на странице оплаты             ▼
                                Применение тарифа в RMW
```

Секрет RMW не попадает в браузер: фронт обращается только к своему API.

### Тело запроса от фронтенда

`POST /api/billing/checkout`

```json
{
  "userUuid": "<rw_uuid из профиля>",
  "product_key": "sub_6m",
  "payment_method": 2
}
```

| Поле | Описание |
|---|---|
| `userUuid` (или `user_ref`) | UUID пользователя в Remnawave |
| `product_key` | `sub_1m`, `sub_6m`, `sub_12m`, `traffic_20gb`, `traffic_50gb` (BFF мапит в `tariff_key` для RMW: `basic_1m`, `pro_6m`, `premium_12m`, `traffic_20gb`, `traffic_50gb`) |
| `payment_method` | **Число:** `2` СБП, `11` карта, `13` крипто (строки `sbp` / `card` / `crypto` BFF тоже принимает) |

BFF в RMW шлёт: `user_ref`, `tariff_key`, `payment_method` (int), `return_url`, `failed_url` из `PUBLIC_SITE_URL` или `BILLING_SUCCESS_URL` / `BILLING_CANCEL_URL` (только `https`).

Ответ RMW пробрасывается клиенту; фронт ожидает поле `payment_url` для редиректа.

Цены и маппинг продуктов на тарифы задаются в **RMW**, а не в этом репозитории.

---

## Отписка от email-рассылки

Письма должны использовать ссылку из `payload.unsubscribe_url`, которую RMW добавляет к email-уведомлениям. Ссылка ведёт на основной сайт:

`GET /unsubscribe-email?t=<signed-token>`

Фронтенд показывает обязательный флоу подтверждения: выбор причины, модальное окно с чекбоксом и кнопка подтверждения. Причина нужна только как шаг подтверждения; BFF её валидирует, но не сохраняет и не отправляет в RMW.

После подтверждения фронт вызывает:

`POST /api/email/unsubscribe`

```json
{
  "token": "v1.<payload>.<signature>",
  "reason": "not_relevant",
  "otherReason": "",
  "consent": true
}
```

BFF проверяет подпись токена через `EMAIL_UNSUBSCRIBE_SECRET`, достаёт `rw_uuid` и серверно вызывает RMW:

`GET {RMW_API_URL}/v1/email/unsubscribe/{user_uuid}`

Заголовки: `Content-Type: application/json`, `X-Api-Key: RMW_API_KEY`.

Для деплоя проверьте, что в RMW `MAIN_SITE=https://220v.shop`, секрет `EMAIL_UNSUBSCRIBE_SECRET` совпадает с этим сервисом, а email-шаблон выводит `payload.unsubscribe_url`.

### Telegram-бот

Ранее бот мог вызывать `POST /api/platega-bot-payment` — этот маршрут удалён. Для оплаты из бота вызывайте **RMW** `POST /v1/billing/checkout` с телом в формате RMW (`user_ref`, `tariff_key`, `payment_method` int, `return_url`, `failed_url`) и `X-Api-Key`, либо отдельный BFF-роут.

---

## Логи API

```bash
docker logs <имя-контейнера-api> --tail 50
```
