import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { WagerQueueConsumer } from "../../src/wagering/infrastructure/messaging/wager-queue-consumer";
import {
  depth,
  eventually,
  FAST,
  message,
  purge,
  queueIsEmpty,
  send,
  setUpQueues,
  spyOnUseCase,
  sqs,
  started,
} from "../support/consumer-harness";
import { TEST_ENV } from "../support/env";
import { freePort } from "../support/ports";
import { SettlementWorld } from "../support/settlement";

// SIGTERM with messages in flight (FR-80), on the real entry point as a separate process, against the real broker
// and a real lock held by the test, which is what keeps a message "in flight" for as long as the test wants.

let world: SettlementWorld;
const running: Bun.Subprocess[] = [];
const pendingReleases: Array<() => Promise<void>> = [];

beforeAll(async () => {
  await setUpQueues();
  world = await SettlementWorld.create();
});
afterAll(async () => {
  await purge();
  sqs.destroy();
  await world.destroy();
});
beforeEach(purge);
afterEach(async () => {
  for (const child of running.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  for (const release of pendingReleases.splice(0)) await release();
  // A killed consumer may leave a long poll open at the broker for one more wait.
  await Bun.sleep(1_200);
  await purge();
}, 30_000);

function startProcess(shutdownTimeoutMs: number) {
  const port = freePort();
  const child = Bun.spawn(["bun", "run", "src/main.ts"], {
    env: {
      ...process.env,
      ...TEST_ENV,
      DATABASE_URL: world.databaseUrl(),
      PORT: String(port),
      APP_ROLES: "api,consumer",
      QUEUE_WAIT_SECONDS: "1",
      // Long enough that a held lock is waited on for the whole test and not given up as a transient failure.
      LOCK_TIMEOUT_MS: "60000",
      STATEMENT_TIMEOUT_MS: "60000",
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push(child);
  return { child, base: `http://localhost:${port}` };
}

async function waitForLive(base: string): Promise<void> {
  await eventually(
    async () => (await fetch(`${base}/health/live`).catch(() => undefined))?.ok === true,
    "the process to be live",
    15_000,
  );
}

/**
 * Waits until the process is inside the first message: received is not enough, because a signal that lands between
 * receiving a batch and starting its first message makes the consumer give all three back, which is right (FR-80) and
 * is not what these tests are about. Settling the first message means waiting on the lock the test holds, so a backend
 * waiting on a lock is the state to find.
 */
async function firstMessageWaitingOnTheLock(): Promise<void> {
  await eventually(async () => (await depth()).inFlight === 3, "the batch to be received");
  await eventually(
    async () =>
      ((
        await world.sql(
          "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
        )
      )[0]?.n as number) >= 1,
    "the first message to be waiting on the wallet lock",
    15_000,
  );
}

/** Three wallets, a message for each, and the first wallet locked: so the first message cannot finish. */
async function threeMessagesFirstStuck() {
  const wallets = [
    await world.openWallet("100.00"),
    await world.openWallet("100.00"),
    await world.openWallet("100.00"),
  ];
  const held = await world.holdLock(wallets[0]?.walletId as string);
  let released = false;
  // Idempotent, so a test calls it where it means to and afterEach calls it whatever happened: a lock left held keeps
  // a transaction open, and the pool with it, until the hook times out.
  const release = async () => {
    if (released) return;
    released = true;
    await held();
  };
  pendingReleases.push(release);
  for (const wallet of wallets) await send(message(wallet), wallet.walletId);
  return { wallets, release };
}

describe("SIGTERM with a message in flight (FR-80)", () => {
  test("the message finishes and is acknowledged, readiness fails meanwhile, and the rest are given back", async () => {
    const { wallets, release } = await threeMessagesFirstStuck();
    const { child, base } = startProcess(20_000);
    await waitForLive(base);
    // All three received in one batch: the first is being settled, waiting on the lock, and two have not started.
    await firstMessageWaitingOnTheLock();

    child.kill("SIGTERM");

    // Still running, since its message cannot finish, and no longer ready.
    await eventually(
      async () => {
        const ready = await fetch(`${base}/health/ready`).catch(() => undefined);
        return ready?.status === 503 && ((await ready.json()) as { draining?: boolean }).draining === true;
      },
      "readiness to report draining",
      5_000,
    );
    expect(child.exitCode).toBeNull();
    expect((await depth()).inFlight).toBe(3);

    await release();
    expect(await child.exited).toBe(143);

    const output = await new Response(child.stdout as ReadableStream).text();
    expect(output).toContain("Draining");
    expect(output).toContain("Returned 2 unstarted message(s) to the queue");
    expect(output).not.toContain("Shutdown deadline exceeded");

    // The one in flight was finished and acknowledged; the two that had not started are visible again at once and
    // untouched, and not hidden for the 30 s visibility timeout.
    expect(await depth()).toEqual({ visible: 2, inFlight: 0 });
    expect(await world.walletState(wallets[0]?.walletId as string)).toEqual({ balance: "20.00", version: 2 });
    for (const wallet of wallets.slice(1)) {
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
    }
  }, 60_000);

  test("past the deadline it exits, and the unacknowledged work comes back by itself", async () => {
    const { wallets, release } = await threeMessagesFirstStuck();
    const { child, base } = startProcess(2_000);
    await waitForLive(base);
    await firstMessageWaitingOnTheLock();

    const signalled = performance.now();
    child.kill("SIGTERM");
    // The lock is never released, so the message in flight cannot finish: the deadline decides.
    expect(await child.exited).toBe(1);
    expect(performance.now() - signalled).toBeLessThan(6_000);
    expect(await new Response(child.stdout as ReadableStream).text()).toContain("Shutdown deadline exceeded");

    // Nothing was lost, nothing applied, and nothing deleted: all three are still held by the broker.
    expect((await depth()).inFlight).toBe(3);
    await release();
    expect(await world.counts(wallets[0]?.walletId as string)).toEqual({
      transactions: 0,
      entries: 0,
      events: 0,
    });

    // The visibility timeout (30 s) gives them back, and another worker settles each exactly once.
    const worker = started(new WagerQueueConsumer(sqs, spyOnUseCase(world).useCase, FAST));
    try {
      await eventually(queueIsEmpty, "the work to come back and be settled", 50_000);
      for (const wallet of wallets) {
        expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
        expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
      }
    } finally {
      await worker.beforeApplicationShutdown();
    }
  }, 90_000);
});
