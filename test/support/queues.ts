import { TEST_ENV } from "./env";

/**
 * Creates the queues the application expects. Idempotent, so every test file that needs a ready application
 * calls it itself: depending on another file having run first is a test that passes on a developer's machine,
 * where the queues exist from earlier runs, and fails on a fresh CI broker, which is how this one was found.
 */
export async function provisionQueues(): Promise<void> {
  const provision = Bun.spawn(["bun", "run", "scripts/provision-queues.ts"], {
    env: { ...process.env, ...TEST_ENV },
    stdout: "ignore",
    stderr: "pipe",
  });
  const exit = await provision.exited;
  if (exit !== 0)
    throw new Error(
      `provisioning the queues failed (${exit}): ${await new Response(provision.stderr).text()}`,
    );
}
