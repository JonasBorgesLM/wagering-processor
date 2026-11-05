import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { TEST_ENV } from "../support/env";

// Runs the real entry point as a separate process, because signal handling and
// startup failures do not exist inside an in-process test.

const running: Bun.Subprocess[] = [];

function start(overrides: Record<string, string> = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = Bun.spawn(["bun", "run", "src/main.ts"], {
    env: { ...process.env, ...TEST_ENV, PORT: String(port), ...overrides },
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push(child);
  return { child, base: `http://localhost:${port}` };
}

async function waitForLive(base: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/health/live`).catch(() => undefined);
    if (response?.ok) return;
    await Bun.sleep(50);
  }
  throw new Error("process never became live");
}

beforeAll(async () => {
  const provision = Bun.spawn(["bun", "run", "scripts/provision-queues.ts"], {
    env: { ...process.env, ...TEST_ENV },
    stdout: "ignore",
  });
  expect(await provision.exited).toBe(0);
});

afterEach(async () => {
  for (const child of running.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
});

describe("process", () => {
  test("FR-61: ready reports both dependencies up", async () => {
    const { base } = start();
    await waitForLive(base);
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", postgres: "up", sqs: "up" });
  });

  test("FR-61: SQS unreachable keeps the process live but not ready", async () => {
    const { base } = start({ SQS_ENDPOINT: "http://localhost:1" });
    await waitForLive(base);
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ postgres: "up", sqs: "down" });
  }, 15_000);

  test("FR-61: PostgreSQL unreachable keeps the process live but not ready", async () => {
    const { base } = start({ DATABASE_URL: "postgres://wagering:wagering@localhost:1/wagering" });
    await waitForLive(base);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ postgres: "down", sqs: "up" });
  }, 15_000);

  // 143 is 128 + SIGTERM: Nest runs the hooks, then re-raises the signal.
  test("FR-80: SIGTERM drains through the shutdown hooks before exiting", async () => {
    const { child, base } = start();
    await waitForLive(base);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await new Response(child.stdout as ReadableStream).text()).toContain("Draining");
    await expect(fetch(`${base}/health/live`)).rejects.toThrow();
  }, 15_000);

  test("exposes Prometheus metrics", async () => {
    const { base } = start();
    await waitForLive(base);
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("process_cpu_user_seconds_total");
  });

  test("an invalid configuration refuses to start", async () => {
    const { child } = start({ APP_ROLES: "nonsense" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stdout as ReadableStream).text()).toContain("Unknown role");
  }, 15_000);
});
