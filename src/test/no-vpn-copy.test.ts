import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Owner rule: the service word «VPN»/«ВПН» must not appear in user-facing copy
 * (ad and social platforms flag it). Legal documents are the only exception.
 * Identifiers such as `getVpnSubscriptionUrl`, storage keys like `vpn_…` and the
 * `vpn220v_bot` handle are not copy, so only a standalone word counts.
 */
const ROOT = path.resolve(__dirname, "../..");

// Legal documents keep the wording; README/docs are developer-only.
const LEGAL_FILES = new Set(["src/pages/Policy.tsx", "src/pages/Terms.tsx"]);

const STANDALONE_WORD = /(?<![\p{L}\p{N}_$])(vpn|впн)(?![\p{L}\p{N}_$])/iu;

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "test" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
}

function userFacingFiles(): string[] {
  return [
    ...walk(path.join(ROOT, "src"), [".ts", ".tsx"]),
    ...walk(path.join(ROOT, "api"), [".mjs"]),
    path.join(ROOT, "index.html"),
    path.join(ROOT, "public/manifest.webmanifest"),
  ]
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
    .filter((file) => !LEGAL_FILES.has(file));
}

describe("no VPN wording in user-facing copy", () => {
  it("matches the standalone word only", () => {
    expect(STANDALONE_WORD.test("220v — быстрый VPN")).toBe(true);
    expect(STANDALONE_WORD.test("Лучший впн")).toBe(true);
    expect(STANDALONE_WORD.test("VPN-подписка")).toBe(true);
    expect(STANDALONE_WORD.test("getVpnSubscriptionUrl()")).toBe(false);
    expect(STANDALONE_WORD.test('"vpn_dashboard_pending_search"')).toBe(false);
    expect(STANDALONE_WORD.test("https://t.me/vpn220v_bot")).toBe(false);
  });

  it("keeps every non-legal source, page meta and the manifest free of it", () => {
    const hits: string[] = [];
    for (const file of userFacingFiles()) {
      readFileSync(path.join(ROOT, file), "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (STANDALONE_WORD.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
