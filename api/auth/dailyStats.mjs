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
export const dailyAuthPendingEmailsKey = (day) => `${PREFIX}:${day}:pending_emails`;

const RECORD_DAILY_AUTH_SCRIPT = `
redis.call("SET", KEYS[1], ARGV[1], "NX")
redis.call("SADD", KEYS[2], ARGV[2])
redis.call("EXPIREAT", KEYS[2], ARGV[4])
if ARGV[5] == "sent" then
  if redis.call("SISMEMBER", KEYS[3], ARGV[2]) == 0 then
    redis.call("HSET", KEYS[4], ARGV[2], ARGV[3])
    redis.call("EXPIREAT", KEYS[4], ARGV[4])
  end
elseif ARGV[5] == "confirmed" then
  redis.call("HDEL", KEYS[4], ARGV[2])
end
return 1
`;

function visibleDates(now, startedAt) {
  if (!startedAt) return [];
  const today = moscowDay(now);
  const startDay = moscowDay(new Date(startedAt));
  return Array.from({ length: HISTORY_DAYS }, (_, index) => dayOffset(today, -index))
    .filter((day) => day >= startDay);
}

export async function recordDailyAuth(kind, email, req, now = new Date()) {
  if (!kinds.has(kind)) throw new Error(`Unknown daily auth kind: ${kind}`);
  try {
    const day = moscowDay(now);
    const normalizedEmail = email.trim().toLowerCase();
    const hash = createHash("sha256").update(normalizedEmail).digest("hex");
    // 00:00 Moscow when this date leaves the 30-calendar-day view.
    const expiresAt = Math.floor((Date.parse(`${day}T00:00:00.000Z`) + HISTORY_DAYS * DAY_MS - 3 * 60 * 60 * 1000) / 1000);
    await redis.eval(
      RECORD_DAILY_AUTH_SCRIPT,
      4,
      STARTED_AT_KEY,
      dailyAuthKey(day, kind),
      dailyAuthKey(day, "confirmed"),
      dailyAuthPendingEmailsKey(day),
      now.toISOString(),
      hash,
      normalizedEmail,
      expiresAt,
      kind,
    );
  } catch (err) {
    req?.log?.warn({ err }, "daily auth tracking failed");
  }
}

export async function buildDailyAuthSnapshot(now = new Date()) {
  const startedAt = await redis.get(STARTED_AT_KEY);
  const today = moscowDay(now);
  if (!startedAt) return { timeZone: TIME_ZONE, startedAt: null, today, days: [] };

  const startDay = moscowDay(new Date(startedAt));
  const dates = visibleDates(now, startedAt);
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

export async function listDailyUnfinishedEmails({ offset = 0, limit = 50, now = new Date() } = {}) {
  const startedAt = await redis.get(STARTED_AT_KEY);
  const dates = visibleDates(now, startedAt);
  const batches = await Promise.all(dates.flatMap((day) => [
    redis.smembers(dailyAuthKey(day, "sent")),
    redis.smembers(dailyAuthKey(day, "attempted")),
    redis.smembers(dailyAuthKey(day, "confirmed")),
    redis.hgetall(dailyAuthPendingEmailsKey(day)),
  ]));
  const items = [];
  let unavailable = 0;
  dates.forEach((date, index) => {
    const sent = batches[index * 4];
    const attempted = new Set(batches[index * 4 + 1]);
    const confirmed = new Set(batches[index * 4 + 2]);
    const emails = batches[index * 4 + 3];
    for (const hash of sent) {
      if (confirmed.has(hash)) continue;
      const email = emails[hash];
      if (!email) {
        unavailable += 1;
        continue;
      }
      items.push({ date, email, reason: attempted.has(hash) ? "code_not_accepted" : "no_code_submitted" });
    }
  });
  items.sort((a, b) => b.date.localeCompare(a.date) || a.email.localeCompare(b.email));
  return {
    timeZone: TIME_ZONE,
    total: items.length + unavailable,
    available: items.length,
    unavailable,
    offset,
    limit,
    items: items.slice(offset, offset + limit),
  };
}
