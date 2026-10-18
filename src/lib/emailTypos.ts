// Suggests a fix for a mistyped email ("ivan-@gmial.com" -> "ivan@gmail.com").
// Pure and dependency-free; the login form shows the result as a non-blocking hint.

export const POPULAR_EMAIL_DOMAINS = [
  "gmail.com",
  "mail.ru",
  "yandex.ru",
  "ya.ru",
  "bk.ru",
  "list.ru",
  "inbox.ru",
  "rambler.ru",
  "icloud.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "proton.me",
  "internet.ru",
] as const;

// Real domains that sit close to a popular one and must never be "corrected".
const KNOWN_VALID_DOMAINS = new Set<string>([
  ...POPULAR_EMAIL_DOMAINS,
  "mail.com", "email.com", "gmx.com", "gmx.de", "gmx.net", "web.de", "googlemail.com", "ymail.com",
  "rocketmail.com", "aol.com", "live.com", "live.ru", "msn.com", "me.com", "mac.com",
  "protonmail.com", "protonmail.ch", "pm.me", "tutanota.com", "tuta.io", "zoho.com",
  "yandex.com", "yandex.by", "yandex.kz", "yandex.ua", "yandex.uz", "yandex.com.tr",
  "inbox.lv", "inbox.lt", "inbox.com", "mail.ua", "mail.kz", "mail.ee", "list.lv",
  "ok.ru", "vk.com", "ya.ua", "ukr.net", "i.ua", "tut.by", "qq.com", "163.com", "126.com",
  "happ.su", "hop.su", "comcast.net", "verizon.net", "att.net", "outlook.de", "outlook.fr",
  "hotmail.fr", "hotmail.de", "hotmail.it", "hotmail.es", "hotmail.co.uk", "yahoo.fr",
  "yahoo.de", "yahoo.co.uk", "yahoo.co.jp", "yahoo.in",
]);

// Brands whose name with any other TLD is almost surely a typo ("gmail.ru" -> "gmail.com").
const BRAND_DOMAINS: Record<string, string> = {
  gmail: "gmail.com",
  icloud: "icloud.com",
  rambler: "rambler.ru",
  yandex: "yandex.ru",
  outlook: "outlook.com",
  hotmail: "hotmail.com",
  yahoo: "yahoo.com",
  proton: "proton.me",
};

/** Optimal-string-alignment Damerau–Levenshtein distance (adjacent swaps cost 1). */
export function damerauLevenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Cleans local-part junk: spaces, leading/trailing ".", "-" or "_", doubled dots. */
export function cleanLocalPart(local: string): string {
  return local
    .replace(/\s+/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .replace(/[-._]+$/, "");
}

function suggestDomain(domain: string): string {
  if (KNOWN_VALID_DOMAINS.has(domain)) return domain;

  const lastDot = domain.lastIndexOf(".");
  const name = lastDot === -1 ? domain : domain.slice(0, lastDot);
  // "name@gmail" (no TLD) or "name@gmail.ru" (wrong TLD).
  const brand = BRAND_DOMAINS[name];
  if (brand) return brand;
  if (lastDot === -1) {
    const bare = POPULAR_EMAIL_DOMAINS.find((d) => d.slice(0, d.lastIndexOf(".")) === name);
    if (bare && name.length >= 4) return bare;
  }

  let best: string | null = null;
  let bestDistance = Infinity;
  let tie = false;
  for (const candidate of POPULAR_EMAIL_DOMAINS) {
    // Short domains ("bk.ru", "ya.ru") are one edit away from many real ones: allow only 1.
    const maxDistance = candidate.length <= 6 ? 1 : 2;
    const distance = damerauLevenshtein(domain, candidate);
    if (distance > maxDistance) continue;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tie = false;
    } else if (distance === bestDistance) {
      tie = true;
    }
  }
  return best && !tie ? best : domain;
}

/** Plain-language list of what is wrong with the local part, e.g. "лишний «-» перед @". */
export function describeLocalPartIssues(local: string): string[] {
  const issues: string[] = [];
  if (/\s/.test(local)) issues.push("пробел в адресе");
  const trimmed = local.replace(/\s+/g, "");
  if (/^\./.test(trimmed)) issues.push("лишняя точка в начале");
  if (/\.{2,}/.test(trimmed)) issues.push("две точки подряд");
  const tail = /[-._]+$/.exec(trimmed)?.[0];
  if (tail) issues.push(tail.length === 1 ? `лишний «${tail}» перед @` : `лишние «${tail}» перед @`);
  return issues;
}

export type EmailTypo = {
  /** The corrected email to offer as a one-tap fix. */
  suggestion: string;
  /** True when the domain was corrected ("gmial.com" -> "gmail.com"). */
  domainChanged: boolean;
  /** Local-part problems, for a "Похоже, в адресе опечатка: ..." hint. */
  localIssues: string[];
};

/**
 * Detects a likely typo and returns the fix, otherwise null.
 * Never flags a well-formed address on a known or uncommon domain.
 */
export function checkEmailTypo(input: string): EmailTypo | null {
  const email = input.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;

  const rawLocal = email.slice(0, at);
  const local = cleanLocalPart(rawLocal);
  const rawDomain = email.slice(at + 1);
  const cleanDomain = rawDomain
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
  if (!local || !cleanDomain || local.includes("@")) return null;

  const domain = suggestDomain(cleanDomain);
  const suggestion = `${local}@${domain}`;
  if (suggestion === email) return null;
  return {
    suggestion,
    domainChanged: domain !== rawDomain,
    localIssues: local === rawLocal ? [] : describeLocalPartIssues(rawLocal),
  };
}

/** Returns a corrected email when the input looks like a typo, otherwise null. */
export function suggestEmailFix(input: string): string | null {
  return checkEmailTypo(input)?.suggestion ?? null;
}
