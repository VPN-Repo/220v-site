import Redis from "ioredis";
import { logger } from "./logger.mjs";

const testRedisUrl = process.env.NODE_ENV === "test" ? process.env.TEST_REDIS_URL?.trim() : "";
const redisUrl = testRedisUrl || process.env.REDIS_URL?.trim() || "redis://127.0.0.1:6379/0";
// ioredis-mock has no cjson/bit Lua libraries, so Lua-based modules use a JS fallback with it.
export const isMockRedis = process.env.NODE_ENV === "test" && !testRedisUrl;
export const redis =
  isMockRedis
    ? new (await import("ioredis-mock")).default()
    : new Redis(redisUrl, {
        connectTimeout: 5000,
        enableReadyCheck: true,
        keepAlive: 30000,
        maxRetriesPerRequest: 3,
      });

// ioredis-mock has no connection status; report it as ready like a connected client.
if (isMockRedis && redis.status === undefined) redis.status = "ready";

redis.on("ready", () => {
  logger.info({ redisStatus: redis.status }, "redis ready");
});

redis.on("close", () => {
  logger.warn({ redisStatus: redis.status }, "redis close");
});

redis.on("end", () => {
  logger.warn({ redisStatus: redis.status }, "redis end");
});

redis.on("reconnecting", (delay) => {
  logger.warn({ redisStatus: redis.status, reconnectDelayMs: delay }, "redis reconnecting");
});

redis.on("error", (err) => {
  logger.error({ err, redisStatus: redis.status }, "redis error");
});
