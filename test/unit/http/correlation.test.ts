import { describe, expect, test } from "bun:test";
import {
  type CorrelatedRequest,
  correlationMiddleware,
} from "../../../src/wagering/infrastructure/http/correlation";

function run(header: string | string[] | undefined) {
  const request: CorrelatedRequest = { headers: { "x-correlation-id": header } };
  const set: Record<string, string> = {};
  let nexted = 0;
  correlationMiddleware(request, { setHeader: (name, value) => (set[name] = value) }, () => nexted++);
  return { id: request.correlationId, set, nexted };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("a caller's own id", () => {
  test.each(["abc", "req-123", "a.b_c:d-e", "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "x".repeat(128)])(
    "%p is kept and echoed",
    (supplied) => {
      const { id, set, nexted } = run(supplied);
      expect(id).toBe(supplied);
      expect(set["X-Correlation-Id"]).toBe(supplied);
      expect(nexted).toBe(1);
    },
  );
});

describe("anything else is replaced, never reflected", () => {
  // This value goes into a response header and into log lines, so a crafted one is how an injection gets in.
  test.each([
    ["a header injection", "abc\r\nSet-Cookie: session=stolen"],
    ["a newline", "abc\ndef"],
    ["a space", "has space"],
    ["markup", "<script>alert(1)</script>"],
    ["a quote", 'a"b'],
    ["too long", "x".repeat(129)],
    ["empty", ""],
    ["a repeated header", ["a", "b"]],
    ["non-ASCII", "café"],
  ])("%s", (_name, supplied) => {
    const { id, set, nexted } = run(supplied);
    expect(id).toMatch(UUID);
    expect(id).not.toBe(supplied);
    expect(set["X-Correlation-Id"]).toBe(id);
    expect(nexted).toBe(1);
  });

  test("none supplied gets a fresh id, different each time", () => {
    const first = run(undefined).id;
    const second = run(undefined).id;
    expect(first).toMatch(UUID);
    expect(first).not.toBe(second);
  });
});
