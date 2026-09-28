import { createHash } from "node:crypto";
import { redis } from "../redis.mjs";

const TIME_ZONE = "Europe/Moscow";
const STARTED_AT_KEY = "v220:auth:daily:started_at";
const PREFIX = "v220:auth:daily";
const HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const kinds = new Set(["sent", "attempted", "confirmed"]);
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function moscowDay(date = new Date()) {
  const parts = Object.fromEntries(dayFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayOffset(day, offset) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export const dailyAuthKey = (day, kind) => `${PREFIX}:${day}:${kind}`;

export async function recordDailyAuth(kind, email, req, now = new Date()) {
  if (!kinds.has(kind)) throw new Error(`Unknown daily auth kind: ${kind}`);
  try {
    const day = moscowDay(now);
    const hash = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
    // 00:00 Moscow on the 31st following date: the day has left the 30-day view.
    const expiresAt = Math.floor((Date.parse(`${day}T00:00:00.000Z`) + 31 * DAY_MS - 3 * 60 * 60 * 1000) / 1000);
    await redis.multi()
      .set(STARTED_AT_KEY, now.toISOString(), "NX")
      .sadd(dailyAuthKey(day, kind), hash)
      .expireat(dailyAuthKey(day, kind), expiresAt)
      .exec();
  } catch (err) {
    req?.log?.warn({ err }, "daily auth tracking failed");
  }
}

export async function buildDailyAuthSnapshot(now = new Date()) {
  const startedAt = await redis.get(STARTED_AT_KEY);
  const today = moscowDay(now);
  if (!startedAt) return { timeZone: TIME_ZONE, startedAt: null, today, days: [] };

  const startDay = moscowDay(new Date(startedAt));
  const dates = Array.from({ length: HISTORY_DAYS }, (_, index) => dayOffset(today, -index))
    .filter((day) => day >= startDay);
  const sets = await Promise.all(dates.flatMap((day) => ["sent", "attempted", "confirmed"]
    .map((kind) => redis.smembers(dailyAuthKey(day, kind)))));
  const days = dates.map((date, index) => {
    const sent = new Set(sets[index * 3]);
    const attempted = new Set(sets[index * 3 + 1]);
    const confirmed = new Set(sets[index * 3 + 2]);
    let noCodeSubmitted = 0;
    let codeNotAccepted = 0;
    for (const hash of sent) {
      if (confirmed.has(hash)) continue;
      if (attempted.has(hash)) codeNotAccepted += 1;
      else noCodeSubmitted += 1;
    }
    return {
      date,
      sent: sent.size,
      unfinished: noCodeSubmitted + codeNotAccepted,
      noCodeSubmitted,
      codeNotAccepted,
      preliminary: date === today,
      partial: date === startDay,
    };
  });
  return { timeZone: TIME_ZONE, startedAt, today, days };
}
