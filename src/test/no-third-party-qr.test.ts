import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Subscription links must never be sent to a third-party QR service: codes are
 * rendered locally in the browser. Fails if any known remote QR endpoint shows
 * up in the frontend sources or the CSP.
 */
const ROOT = path.resolve(__dirname, "../..");
// Built from parts so this file itself does not match the scan.
const FORBIDDEN = [["api", "qrserver", "com"].join("."), ["chart", "googleapis"].join(".")];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("no third-party QR services", () => {
  it("src, index.html and nginx.conf do not reference remote QR endpoints", () => {
    const files = [...walk(path.join(ROOT, "src")), path.join(ROOT, "index.html"), path.join(ROOT, "nginx.conf")];
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const host of FORBIDDEN) {
        if (text.includes(host)) hits.push(`${path.relative(ROOT, file)}: ${host}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
