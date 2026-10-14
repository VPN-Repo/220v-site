import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { SESSION_COOKIE } from "../config.mjs";
import { redis } from "../redis.mjs";
import { methodSchema, sendCodeSchema } from "../auth/schemas.mjs";

function makeRateLimit(opts) {
  const base = {
    ...opts,
    standardHeaders: true,
    legacyHeaders: false,
  };
  if (process.env.NODE_ENV === "test") {
    return rateLimit(base);
  }
  return rateLimit({
    ...base,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: opts.prefix || "v220:rl:",
    }),
  });
}

export const sendCodeIpMinuteLimiter = makeRateLimit({
  windowMs: 60 * 1000,
  max: 8,
  prefix: "v220:rl:sendcode:ip:1m:",
  message: { error: "Слишком много запросов. Попробуйте позже." },
});

export const sendCodeIpHourLimiter = makeRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  prefix: "v220:rl:sendcode:ip:1h:",
  message: { error: "Слишком много запросов. Попробуйте позже." },
});

export const sendCodeEmailLimiter = makeRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 375,
  prefix: "v220:rl:sendcode:email:",
  keyGenerator: (req) => {
    const parsed = sendCodeSchema.safeParse(req.body);
    return parsed.success ? parsed.data.email : req.ip;
  },
  message: { error: "Слишком много запросов для этого email. Попробуйте позже." },
});

export const verifyIpLimiter = makeRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  prefix: "v220:rl:verify:ip:",
  message: { error: "Слишком много попыток проверки. Попробуйте позже." },
});

export const authMethodLimiter = makeRateLimit({
  windowMs: 60 * 1000,
  max: 30,
  prefix: "v220:rl:method:ip:",
  message: { error: "Слишком много запросов. Попробуйте позже." },
});

export const passwordIpLimiter = makeRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  prefix: "v220:rl:password:ip:",
  message: { error: "Слишком много попыток входа. Попробуйте позже." },
});

export const passwordEmailLimiter = makeRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefix: "v220:rl:password:email:",
  keyGenerator: (req) => {
    const parsed = methodSchema.safeParse(req.body);
    return parsed.success ? parsed.data.email : req.ip;
  },
  message: { error: "Слишком много попыток входа. Попробуйте позже." },
});

export const passwordChangeEmailLimiter = makeRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  prefix: "v220:rl:password:change:email:",
  keyGenerator: (req) => req.session?.email || req.ip,
  message: { error: "Слишком много запросов кода. Попробуйте позже." },
});

export const passwordChangeAttemptLimiter = makeRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefix: "v220:rl:password:change:attempt:",
  keyGenerator: (req) => req.session?.email || req.ip,
  message: { error: "Слишком много попыток. Попробуйте позже." },
});

export const adminPasswordLimiter = makeRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  prefix: "v220:rl:admin:password:ip:",
  message: { error: "Слишком много запросов. Попробуйте позже." },
});

export const checkoutSessionLimiter = makeRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1250,
  prefix: "v220:rl:checkout:sid:",
  keyGenerator: (req) => req.cookies?.[SESSION_COOKIE] || req.ip,
  message: { error: "Слишком много попыток оплаты. Попробуйте позже." },
});

export const emailUnsubscribeIpLimiter = makeRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  prefix: "v220:rl:emailunsubscribe:ip:",
  message: { error: "Слишком много попыток отписки. Попробуйте позже." },
});

// Поллинг: сообщения 8 с, мета 20 с (до 3 req за цикл). До ~10 сессий на один IP (NAT).
// Бюджет на сессию: ~113 + ~135 = ~248 req/15 мин + запас → 320; на IP: 3600 (≈320 × 10 + запас).
export const talkmeIpLimiter = makeRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3600,
  prefix: "v220:rl:talkme:ip:",
  message: { error: "Слишком много запросов к чату. Попробуйте позже." },
});

export const talkmeSessionLimiter = makeRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 320,
  prefix: "v220:rl:talkme:sid:",
  keyGenerator: (req) => req.cookies?.[SESSION_COOKIE] || req.ip,
  message: { error: "Слишком много запросов к чату. Попробуйте позже." },
});

export const chatUploadLimiter = makeRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  prefix: "v220:rl:chatupload:sid:",
  keyGenerator: (req) => req.cookies?.[SESSION_COOKIE] || req.ip,
  message: { error: "Слишком много загрузок файлов. Попробуйте позже." },
});

export const refClickIpLimiter = makeRateLimit({
  windowMs: 60 * 1000,
  max: 15,
  prefix: "v220:rl:refclick:ip:",
  message: { error: "Слишком много переходов по ссылке. Попробуйте позже." },
});

export const chatIdentityLimiter = makeRateLimit({
  windowMs: 60 * 1000,
  max: 30,
  prefix: "v220:rl:chat:identity:sid:",
  keyGenerator: (req) => req.cookies?.[SESSION_COOKIE] || req.ip,
  message: { error: "Слишком много запросов. Попробуйте позже." },
});
