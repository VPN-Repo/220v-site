# syntax=docker/dockerfile:1.7
# node:22-alpine — pin digest in production deploys
FROM node:22-alpine AS deps
WORKDIR /app
COPY api/package.json api/package-lock.json* ./
RUN --mount=type=cache,id=v220-api-npm,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --omit=dev --prefer-offline --no-audit --fund=false; else npm install --omit=dev --prefer-offline --no-audit --fund=false; fi

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache wget
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node api/package.json ./package.json
COPY --chown=node:node api/index.mjs ./index.mjs
COPY --chown=node:node api/env.mjs ./env.mjs
COPY --chown=node:node api/config.mjs ./config.mjs
COPY --chown=node:node api/logger.mjs ./logger.mjs
COPY --chown=node:node api/redis.mjs ./redis.mjs
COPY --chown=node:node api/mailer.mjs ./mailer.mjs
COPY --chown=node:node api/talkme-routes.mjs ./talkme-routes.mjs
COPY --chown=node:node api/http ./http
COPY --chown=node:node api/auth ./auth
COPY --chown=node:node api/email ./email
COPY --chown=node:node api/referrals ./referrals
COPY --chown=node:node api/billing ./billing
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1
CMD ["node", "index.mjs"]
