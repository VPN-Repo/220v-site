import { describe, expect, it } from "vitest";
import {
  HAPP_FALLBACK_HOST,
  happSubscriptionLink,
  oneClickHappSubscriptionUrl,
  oneClickHappUrl,
} from "@/lib/happ";

const EXPECTED =
  "https://220v.click/AbC123#220v?fallback-url=https%3A%2F%2F220vsub.online%2FAbC123%23220v-reserve";

describe("happSubscriptionLink", () => {
  it("adds the title and the encoded fallback-url in the Happ fragment format", () => {
    expect(happSubscriptionLink("https://220v.click/AbC123")).toBe(EXPECTED);
  });

  it("keeps the same path and query on the fallback host", () => {
    const link = happSubscriptionLink("https://220v.click/api/sub/AbC123?a=1&b=2");
    expect(link.startsWith("https://220v.click/api/sub/AbC123?a=1&b=2#220v?fallback-url=")).toBe(true);
    const encoded = link.split("?fallback-url=")[1];
    expect(decodeURIComponent(encoded)).toBe(`https://${HAPP_FALLBACK_HOST}/api/sub/AbC123?a=1&b=2#220v-reserve`);
    // the encoded value carries no raw separators that would split the fragment
    expect(encoded).not.toMatch(/[#?&/:]/);
  });

  it("replaces an existing fragment instead of stacking a second one", () => {
    expect(happSubscriptionLink("https://220v.click/AbC123#old-name?x=1")).toBe(EXPECTED);
    expect(happSubscriptionLink(EXPECTED)).toBe(EXPECTED);
  });

  it("leaves other hosts, ports, http and invalid strings unchanged", () => {
    for (const url of [
      "https://sub.example/AbC123",
      "https://220v.click.evil.example/AbC123",
      "https://220vsub.online/AbC123",
      "https://220v.click:8443/AbC123",
      "http://220v.click/AbC123",
      "not a url",
      "",
    ]) {
      expect(happSubscriptionLink(url)).toBe(url);
    }
  });

  it("builds the one-click deep link from the full meta URL", () => {
    expect(oneClickHappSubscriptionUrl("https://220v.click/AbC123")).toBe(
      `happ://add/${encodeURIComponent(EXPECTED)}`,
    );
    expect(oneClickHappUrl("https://sub.example/x")).toBe("happ://add/https%3A%2F%2Fsub.example%2Fx");
  });
});
