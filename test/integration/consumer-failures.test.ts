import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { TransientFailureError } from "../../src/wagering/application/errors";
import { WagerQueueConsumer } from "../../src/wagering/infrastructure/messaging/wager-queue-consumer";
import {
  deadLetterUrl,
  depth,
  eventually,
  FAST,
  message,
  purge,
  queueIsEmpty,
  readDeadLetters,
  send,
  setUpQueues,
  spyOnUseCase as spy,
  sqs,
  started,
} from "../support/consumer-harness";
import { SettlementWorld } from "../support/settlement";

// What the consumer does with a message it could not settle (section 3.11, NFR-11), against the real broker, and
// for the transient case against a PostgreSQL that is really stopped.

let world: SettlementWorld;
const spyOnUseCase = (override?: (call: number) => void) => spy(world, override);

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
afterEach(purge);

type Wallet = { walletId: string; playerId: string };

describe("a permanent failure goes to the DLQ at once", () => {
  test.each<[string, (wallet: Wallet) => unknown, string]>([
    ["malformed JSON", () => "{not json", "the message body is not JSON"],
    ["an unknown type", (w) => ({ ...message(w), type: "Other" }), "unknown message type"],
    ["an invalid payload", (w) => message(w, { money: { amount: "1.5", currency: "BRL" } }), "data.money"],
    ["an OPENING", (w) => message(w, { kind: "OPENING" }), "OPENING is internal"],
    [
      "a wallet that does not exist",
      () => message({ walletId: randomUUID(), playerId: randomUUID() }),
      "does not exist",
    ],
  ])("%s", async (_name, build, reason) => {
    const wallet = await world.openWallet("100.00");
    const consumer = started(new WagerQueueConsumer(sqs, spyOnUseCase().useCase, FAST));
    try {
      const body = build(wallet);
      await send(body, wallet.walletId);
      await eventually(
        async () => (await depth(deadLetterUrl)).visible === 1,
        "the message to reach the DLQ",
      );
      await eventually(queueIsEmpty, "the input queue to be empty");

      const [dead] = await readDeadLetters();
      expect(dead?.body).toBe(typeof body === "string" ? body : JSON.stringify(body));
      expect(dead).toMatchObject({ kind: "permanent", receives: "1" });
      expect(dead?.reason).toContain(reason);
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  });

  test("a message id reused with other content (INT-17), and the wallet's next message is not held up", async () => {
    const wallet = await world.openWallet("100.00");
    const consumer = started(new WagerQueueConsumer(sqs, spyOnUseCase().useCase, FAST));
    try {
      const original = message(wallet, { money: { amount: "10.00", currency: "BRL" } });
      await send(original, wallet.walletId);
      await eventually(queueIsEmpty, "the original");

      const liar = message(wallet, {
        messageId: original.messageId,
        money: { amount: "5.00", currency: "BRL" },
      });
      const next = message(wallet, { money: { amount: "20.00", currency: "BRL" } });
      await send(liar, wallet.walletId);
      await send(next, wallet.walletId);
      await eventually(queueIsEmpty, "both to be finished with");

      const dead = await readDeadLetters();
      expect(dead).toHaveLength(1);
      expect(dead[0]?.reason).toContain("seen before with different content");
      // The original and the next one applied; the liar did not. A dead message must not stall its wallet.
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "70.00", version: 3 });
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  });

  test("a DLQ that cannot be written leaves the message where it is, not lost", async () => {
    const wallet = await world.openWallet("100.00");
    const brokenDeadLetter = new Proxy(sqs, {
      get(client, property) {
        if (property !== "send") return Reflect.get(client, property);
        return (
          command: { constructor: { name: string }; input: { QueueUrl?: string } },
          ...rest: unknown[]
        ) => {
          if (command.constructor.name === "SendMessageCommand" && command.input.QueueUrl === deadLetterUrl) {
            return Promise.reject(new Error("the DLQ is away"));
          }
          return (client.send as (...args: unknown[]) => unknown).call(client, command, ...rest);
        };
      },
    }) as unknown as SQSClient;
    const consumer = started(new WagerQueueConsumer(brokenDeadLetter, spyOnUseCase().useCase, FAST));
    try {
      await send("{not json", wallet.walletId);
      await eventually(async () => (await depth()).inFlight === 1, "the message to be received");
      await Bun.sleep(500);
      expect(await queueIsEmpty()).toBe(false);
      expect((await depth(deadLetterUrl)).visible).toBe(0);
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  });
});

describe("a transient failure is retried with a backoff (NFR-11)", () => {
  test("it stays hidden for the backoff, then comes back and settles once", async () => {
    const wallet = await world.openWallet("100.00");
    const policy = { ...FAST, backoff: { baseSeconds: 4, capSeconds: 4 } };
    const { useCase, calls, results } = spyOnUseCase((call) => {
      if (call <= 1) throw new TransientFailureError("the database is away");
    });
    const consumer = started(new WagerQueueConsumer(sqs, useCase, policy));
    try {
      await send(message(wallet), wallet.walletId);
      await eventually(() => calls() === 1, "the first attempt");
      const failedAt = performance.now();

      await Bun.sleep(1_000);
      expect(calls()).toBe(1);
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });

      await eventually(() => results.length === 1, "the retry", 15_000);
      // A backoff of 4 s is drawn from 2 to 4 s: the retry cannot have come sooner than the lower half.
      expect(performance.now() - failedAt).toBeGreaterThanOrEqual(1_900);
      await eventually(queueIsEmpty, "the retry to be acknowledged");
      expect(calls()).toBe(2);
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
      expect((await depth(deadLetterUrl)).visible).toBe(0);
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  }, 30_000);

  test("is bounded: after the last delivery the message goes to the DLQ with its reason", async () => {
    const wallet = await world.openWallet("100.00");
    const { useCase, calls } = spyOnUseCase(() => {
      throw new TransientFailureError("the database is still away");
    });
    const consumer = started(new WagerQueueConsumer(sqs, useCase, FAST));
    try {
      await send(message(wallet), wallet.walletId);
      await eventually(async () => (await depth(deadLetterUrl)).visible === 1, "the DLQ", 25_000);
      await eventually(queueIsEmpty, "the input queue to be empty");

      expect(calls()).toBe(FAST.maxReceives);
      const [dead] = await readDeadLetters();
      expect(dead).toMatchObject({ kind: "attempts-exhausted", receives: String(FAST.maxReceives) });
      expect(dead?.reason).toContain("the database is still away");
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  }, 40_000);

  test("a failure nobody foresaw is retried like a transient one, and bounded the same", async () => {
    const wallet = await world.openWallet("100.00");
    const { useCase, calls } = spyOnUseCase((call) => {
      if (call <= 2) throw new TypeError("a bug");
    });
    const consumer = started(new WagerQueueConsumer(sqs, useCase, FAST));
    try {
      await send(message(wallet), wallet.walletId);
      await eventually(queueIsEmpty, "the message to be settled", 15_000);
      expect(calls()).toBe(3);
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  }, 30_000);
});

describe("with PostgreSQL really stopped", () => {
  const compose = async (...args: string[]) => {
    const child = Bun.spawn(["docker", "compose", ...args], { stdout: "ignore", stderr: "pipe" });
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
  };

  test("the message is retried while it is away, and settles once when it is back", async () => {
    const wallet = await world.openWallet("100.00");
    // Backoffs of 3 to 5 s: the five deliveries span about 16 s, which outlasts a restart of PostgreSQL. The bound
    // itself has its own test above.
    const policy = { ...FAST, backoff: { baseSeconds: 5, capSeconds: 5 } };
    const real = spyOnUseCase();
    const consumer = started(new WagerQueueConsumer(sqs, real.useCase, policy));
    try {
      await compose("stop", "postgres");
      await send(message(wallet), wallet.walletId);
      // A delivery that fails on a database that is not there is retried, not dead-lettered.
      await eventually(async () => (await depth()).inFlight + (await depth()).visible === 1, "the message");
      await Bun.sleep(4_000);
      expect(real.calls()).toBeGreaterThanOrEqual(1);
      expect(real.results).toEqual([]);
      expect((await depth(deadLetterUrl)).visible).toBe(0);
    } finally {
      await compose("up", "-d", "--wait", "postgres");
    }
    try {
      await eventually(
        () => real.results.length === 1,
        "the message to settle once PostgreSQL is back",
        25_000,
      );
      await eventually(queueIsEmpty, "the acknowledgement");
      expect(real.results[0]).toMatchObject({ status: "PROCESSED", idempotentReplay: false });
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
      expect((await depth(deadLetterUrl)).visible).toBe(0);
    } finally {
      // Whatever happened, the next test must find PostgreSQL up and no consumer left polling.
      await compose("up", "-d", "--wait", "postgres");
      await consumer.beforeApplicationShutdown();
    }
  }, 60_000);
});
