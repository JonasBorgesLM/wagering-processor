import { describe, expect, test } from "bun:test";
import { freePort } from "../support/ports";

// The test support that hands ports to child processes. It is kept below every ephemeral range, because a port
// inside it was found taken on CI by an outgoing connection (#57).

describe("a port for a child process", () => {
  test("is below every ephemeral range, free now, and never handed out twice", () => {
    const ports = Array.from({ length: 50 }, () => freePort());
    expect(new Set(ports).size).toBe(50);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(20_000);
      expect(port).toBeLessThan(32_768);
      const listener = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } });
      listener.stop(true);
    }
  });
});
