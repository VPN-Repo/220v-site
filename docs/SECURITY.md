# Security

## Session model

- After OTP verify, API issues `v220_sid` (httpOnly, Secure, SameSite=Lax) and `v220_csrf`.
- Session state lives in Redis (`v220:sess:{sid}`): `userUuid`, `email`, `csrf`, `expAt`.
- All user-specific routes use `requireSession`; `userUuid` is never taken from the request body.
- Non-GET requests require header `X-CSRF-Token` matching the `v220_csrf` cookie.

## Redis

- Sessions, OTP hashes, rate limits, and auth statistics are stored in Redis.
- Production Redis runs with:
  - **AOF persistence** (`appendonly yes`, `appendfsync everysec`) on named Docker volume `redis-data` — sessions survive container restarts (at most ~1s of writes may be lost on crash).
  - **Password** via `REDIS_PASSWORD` / `REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379/0`.
  - **Memory cap** `maxmemory 2gb` with `noeviction` — Redis refuses new writes instead of silently evicting active sessions.
  - **Dangerous commands disabled**: `CONFIG`, `FLUSHALL`, `FLUSHDB`, `DEBUG`, `KEYS`.
  - **Network isolation**: Redis is on the internal Docker bridge only; port 6379 is not published to the host.
- Auth statistics keys (`auth:stats:type`, `auth:stats:ip`, `auth:stats:email`) have a sliding 30-day TTL.
- Recent auth events list (`auth:events`) is trimmed to 200 entries via `LTRIM`.

## Threat model

| Vector | Mitigation |
|---|---|
| OTP brute-force | Max 5 attempts per code; 60s cooldown between send-code; only SHA-256 hash stored; `crypto.timingSafeEqual` |
| Session hijack | Opaque 256-bit session id; httpOnly + Secure + SameSite=Lax cookies |
| CSRF | Double-submit cookie + header check; CSRF token also stored in Redis session |
| SSRF via payment redirect | `BILLING_ALLOWED_HOSTS` whitelist for `payment_url` from RMW |
| Redis memory DoS | `maxmemory 2gb`, `noeviction`, rate limits on send-code (IP + email) and verify (IP) |
| Talk-Me proxy abuse | All `/api/talkme/*` and chat upload require `requireSession` + CSRF; email/clientId bound to session; IP + session rate limits |
| Stored XSS via chat uploads | SVG uploads rejected; static attachment responses use `nosniff` + restrictive CSP |
| Internal lateral movement | Redis password, disabled dangerous commands, internal network only |
| PII in debug logs | No agent debug ingest in production API code |

## OTP

- 5-digit code generated server-side; only SHA-256 hash stored in Redis (`otp:{email}`), TTL 10 minutes.
- Max 5 verification attempts; 60s cooldown between send-code requests per email.
- Hash comparison uses `crypto.timingSafeEqual`.

## Support chat (Talk-Me proxy)

- Custom chat UI (`/chat`) uses backend proxy routes under `/api/talkme/*` and `/api/support/chat-attachment`.
- All mutating chat routes require the same session model as `/api/me`: cookie `v220_sid` + header `X-CSRF-Token`.
- `email` and Talk-Me `clientId` are derived from `req.session.email` on the server; client-supplied identity fields are ignored or validated.
- Rate limits: 120 req / 15 min per IP and 300 req / 15 min per session on Talk-Me routes; 20 uploads / hour per session on chat attachment upload.
- SVG files are rejected at upload. Uploaded files are served with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'`.
- `attachmentUrl` in `/api/talkme/send` must point to a file uploaded via `/api/support/chat-attachment` on the same host.
- Server-side Talk-Me token: set `TALKME_API_TOKEN` only (do not expose via `VITE_*` build args).

## Email (AWS SES)

- OTP-письма отправляются через AWS SES по SMTP (`api/mailer.mjs`), без
  внешних HTTP-API. Соединение TLS-only (`secure: true` на порту 465 или
  `requireTLS: true` на 587), минимум TLSv1.2.
- Креды (`SES_SMTP_USER` / `SES_SMTP_PASSWORD`) — это SES SMTP credentials,
  а не IAM access keys. IAM-пользователь под ними должен иметь минимальную
  политику:
  ```json
  {
    "Effect": "Allow",
    "Action": "ses:SendRawEmail",
    "Resource": "arn:aws:ses:eu-central-1:<account>:identity/220v.shop"
  }
  ```
- From-адрес (`MAIL_FROM_EMAIL`) должен соответствовать верифицированному в
  SES identity (домен или email). DKIM/SPF/DMARC настраиваются на стороне DNS.
- Сам OTP-код, plain-text email получателя и SMTP-пароль никогда не пишутся в
  логи. В логах — только `emailHash` (SHA-256 от email) и `messageId` от SES.
- Ошибки SMTP не пробрасываются клиенту: при сбое отправки API возвращает
  generic `502 { error: "Failed to send code" }` и удаляет OTP из Redis,
  чтобы пользователь мог сразу повторить запрос.

## Secrets

- Never commit `.env`. Use `.env.example` as template only.
- Rotate secrets per environment (dev/staging/prod must not share keys).
- If `.env` was ever committed, run:

```bash
pip install git-filter-repo  # once
git filter-repo --invert-paths --path .env --force
git push --force --all
```

Then rotate **all** values that appeared in history (RMW, Remnawave, mail gateway, payment providers).

## Incident response

1. Revoke leaked tokens at each provider.
2. Force-push history rewrite if secrets were in git.
3. Rotate `SES_SMTP_USER` / `SES_SMTP_PASSWORD` (SES Console → SMTP settings →
   delete old credential → create new), `RMW_API_KEY`, `REMNAWAVE_TOKEN`,
   `REDIS_PASSWORD`, payment keys.
4. Flush Redis sessions (requires admin access to the container):

```bash
# Scan for session keys (KEYS is disabled in prod Redis)
docker exec v220-redis-1 redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
  --scan --pattern 'v220:sess:*' | xargs -r docker exec -i v220-redis-1 \
  redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DEL
```

5. Notify users if accounts or payments could have been affected.

## Operations

- Run `gitleaks` locally before push (see `.github/workflows/security.yml`).
- Redis AOF files contain session emails and UUIDs — restrict volume access on the host; do not back up `redis-data` to untrusted storage.
- External TLS proxy should send `X-Forwarded-For`; API uses `trust proxy` for rate limits.

## Redis migration (ephemeral → persistent)

One-time migration when enabling AOF + password:

```bash
# 1. Generate password and add to .env (do not commit)
openssl rand -hex 32   # → REDIS_PASSWORD
# REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379/0

# 2. Recreate Redis with new config (creates empty redis-data volume)
docker compose up -d redis

# 3. Recreate API to pick up REDIS_URL with password
docker compose up -d --force-recreate api

# 4. Verify persistence is enabled
docker exec v220-redis-1 redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO persistence
# expect: aof_enabled:1, aof_last_write_status:ok

# 5. Verify memory limit
docker exec v220-redis-1 redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO memory
# expect: maxmemory_human:2.00G

# 6. Test session survival: log in, restart Redis, refresh page — should stay logged in
docker compose restart redis
```

**Note:** Step 2–3 will invalidate all existing sessions once (users must log in again). After that, restarts preserve sessions via AOF.

## Payment URLs

Set `BILLING_ALLOWED_HOSTS` to comma-separated hostnames allowed in `payment_url` from RMW (payment gateway hosts, not your site origin).
