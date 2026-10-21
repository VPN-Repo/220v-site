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
| `BACKUP_SMTP_HOST` / `BACKUP_SMTP_USER` / `BACKUP_SMTP_PASSWORD` | Опционально: резервный SMTP для повторной отправки кода (например, Unisender Go). Включается, только если заданы все три; иначе все письма идут через SES, как раньше |
| `BACKUP_SMTP_PORT` | Порт резервного SMTP, по умолчанию `587` |
| `BACKUP_SMTP_SECURE` | `true` — implicit TLS (обычно порт 465); по умолчанию `false`: на 587 используется обязательный STARTTLS |
| `BACKUP_MAIL_FROM_EMAIL` / `BACKUP_MAIL_FROM_NAME` | Опционально: отправитель для резервного SMTP; по умолчанию `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` |
| `UNISENDER_API_KEY` | Опционально: API-ключ Unisender Go (не SMTP-пароль!) для проверки подписи вебхука `/api/webhooks/unisender`. Пусто — вебхук отвечает 503 и ничего не делает |
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

### Резервный SMTP для кодов подтверждения

Коды входа и коды подтверждения установки/смены пароля по умолчанию отправляются через AWS SES. Если резервный SMTP настроен (`BACKUP_SMTP_*`), сервер сам выбирает провайдера:

- первая успешная отправка кода за 15 минут идёт через SES, каждая следующая в этом окне (кнопка «Отправить код ещё раз») — через резервный SMTP. Счётчик успешных отправок хранится в Redis: для входа — по email (ключ `v220:mail:otp_sends:<sha256>`), для смены пароля — по сессии (`v220:mail:password_sends:<sid>`), как и cooldown этих потоков;
- если выбранный провайдер не принял письмо, один раз пробуем другой; ошибка «Не удалось отправить код» возвращается, только если не сработали оба, и такая попытка не засчитывается;
- cooldown между отправками (30 с), формат кода, шаблоны писем и фронтенд не меняются; в логах и в событии `send_code_sent` пишется провайдер (`primary` / `backup`) и признак `failover`.

Пример для Unisender Go: `BACKUP_SMTP_HOST=<SMTP-хост из кабинета Unisender Go>`, `BACKUP_SMTP_PORT=587`, `BACKUP_SMTP_USER=<SMTP-логин>`, `BACKUP_SMTP_PASSWORD=<SMTP-пароль / API-ключ>`.

**Важно:** домен отправителя (`MAIL_FROM_EMAIL`, либо `BACKUP_MAIL_FROM_EMAIL`, если задан) должен быть подтверждён в Unisender — добавьте в DNS выданные им записи SPF и DKIM. Иначе Unisender отклонит письма или они попадут в спам.

### Вебхук Unisender Go: почему не пришёл код

Письма через резервный SMTP помечаются заголовком `X-UNISENDER-GO: {"global_metadata":{"brand":"v220"}}`; письма SES не меняются. Unisender присылает статусы доставки на `POST /api/webhooks/unisender`:

- подпись: поле `auth` = MD5 тела запроса, в котором значение `auth` заменено на `UNISENDER_API_KEY`; неверная подпись — 403, ключ не задан — 503. Тело до 1 МБ, поддерживается gzip;
- учитываются только события `transactional_email_status` с `metadata.brand = v220` (на одном аккаунте Unisender несколько сайтов, у каждого свой вебхук, каждый получает все события и фильтрует по бренду);
- несуществующий адрес, переполненный ящик, блокировка/спам и отписка сохраняются в Redis (`v220:mailbounce:<email>`, TTL 30 / 3 / 7 / 30 дней), статус `delivered` удаляет запись; `temporary_retry` и остальное только логируются (email в логах маскируется);
- код всё равно отправляется: `POST /api/auth/send-code` добавляет в ответ `deliveryWarning`, а экран ввода кода 2 минуты раз в 10 с спрашивает `GET /api/auth/delivery-status?email=` и показывает предупреждение с кнопкой «Изменить почту». Этот запрос отвечает только для адреса, на который этот браузер только что запросил код (httpOnly-cookie `v220_otp_pending` = владелец текущего OTP), иначе `{"warning": null}`.

Регистрация вебхука (один раз на сайт; повторный вызов с тем же `url` обновляет вебхук). При регистрации Unisender проверяет, что `GET https://<site>/api/webhooks/unisender` отвечает 200:

```bash
curl -sS https://goapi.unisender.ru/ru/transactional/api/v1/webhook/set.json \
  -H 'Content-Type: application/json' \
  -H 'X-API-KEY: <UNISENDER_API_KEY>' \
  -d '{
    "url": "https://<site>/api/webhooks/unisender",
    "status": "active",
    "event_format": "json_post",
    "delivery_info": 1,
    "single_event": 0,
    "max_parallel": 5,
    "events": {
      "email_status": ["delivered", "soft_bounced", "hard_bounced", "spam", "unsubscribed"]
    }
  }'
```

Ключ в `X-API-KEY` и `UNISENDER_API_KEY` должен быть тем же ключом (пользователя или проекта), которым подписываются вебхуки. Проверить: `.../webhook/list.json` с тем же заголовком.

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
