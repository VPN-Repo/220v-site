# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=v220-web-npm,target=/root/.npm \
    npm ci --prefer-offline --no-audit --fund=false
COPY . .
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:alpine
RUN apk add --no-cache apache2-utils wget
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx-entrypoint.sh /usr/local/bin/v220-nginx-entrypoint.sh
RUN chmod +x /usr/local/bin/v220-nginx-entrypoint.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/v220-nginx-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ || exit 1
