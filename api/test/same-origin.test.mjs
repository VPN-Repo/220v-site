import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requireSameOriginJson } from "../http/sameOrigin.mjs";

function run({ headers = {}, json = true, method = "POST" } = {}) {
  const lower = Object.fromEntries(Object.entries({ host: "220v.shop", ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method, path: "/api/auth/verify-link", is: () => json, get: (name) => lower[name.toLowerCase()] };
  const out = { status: 200, nextCalled: false };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json() {
      return this;
    },
  };
  requireSameOriginJson(req, res, () => {
    out.nextCalled = true;
  });
  return out;
}

describe("login CSRF guard", () => {
  it("lets same-origin JSON requests through", () => {
    assert.equal(run({ headers: { "Sec-Fetch-Site": "same-origin", Origin: "https://220v.shop" } }).nextCalled, true);
    assert.equal(run().nextCalled, true);
  });

  it("rejects cross-site and same-site browser requests", () => {
    assert.equal(run({ headers: { "Sec-Fetch-Site": "cross-site" } }).status, 403);
    assert.equal(run({ headers: { "Sec-Fetch-Site": "same-site" } }).status, 403);
  });

  it("trusts Sec-Fetch-Site over a Host rewritten by the proxy", () => {
    const out = run({ headers: { host: "api:3001", "Sec-Fetch-Site": "same-origin", Origin: "https://220v.shop" } });
    assert.equal(out.nextCalled, true);
  });

  it("accepts an Origin-only request for the configured site address", () => {
    assert.equal(run({ headers: { host: "api:3001", Origin: "https://220v.shop" } }).nextCalled, true);
  });

  it("rejects a foreign or opaque Origin", () => {
    assert.equal(run({ headers: { Origin: "https://evil.example" } }).status, 403);
    assert.equal(run({ headers: { Origin: "null" } }).status, 403);
  });

  it("rejects non-JSON bodies such as form posts", () => {
    const out = run({ json: false });
    assert.equal(out.status, 415);
    assert.equal(out.nextCalled, false);
  });
});
