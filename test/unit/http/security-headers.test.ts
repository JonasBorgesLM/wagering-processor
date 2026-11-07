import { describe, expect, test } from "bun:test";
import { securityHeadersMiddleware } from "../../../src/wagering/infrastructure/http/security-headers";

// Requirements: FR-100.

function run(request: { secure?: boolean; headers?: Record<string, string> }) {
  const set: Record<string, string> = {};
  let called = false;
  securityHeadersMiddleware(
    { headers: {}, ...request },
    { setHeader: (name, value) => (set[name] = value) },
    () => {
      called = true;
    },
  );
  return { set, called };
}

describe("the response headers of an API that returns data", () => {
  test("every response is told not to be sniffed, framed, loaded from, referred or cached", () => {
    const { set, called } = run({});
    expect(called).toBe(true);
    expect(set).toEqual({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
  });

  test("Strict-Transport-Security only goes on a request that arrived over TLS", () => {
    expect(run({}).set["Strict-Transport-Security"]).toBeUndefined();
    expect(
      run({ headers: { "x-forwarded-proto": "http" } }).set["Strict-Transport-Security"],
    ).toBeUndefined();
    expect(run({ secure: true }).set["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(run({ headers: { "x-forwarded-proto": "https" } }).set["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});
