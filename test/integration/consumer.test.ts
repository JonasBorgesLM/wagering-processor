import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { QUEUES } from "../../src/platform/config/config";
import { TransientFailureError } from "../../src/wagering/application/errors";
import type {
  SubmissionResult,
  SubmitWagerTransaction,
} from "../../src/wagering/application/submit-wager-transaction";
import { WagerQueueConsumer } from "../../src/wagering/infrastructure/messaging/wager-queue-consumer";
import { startApp } from "../support/app";
import { TEST_ENV } from "../support/env";
import { provisionQueues } from "../support/queues";
import { SettlementWorld } from "../support/settlement";

// Real PostgreSQL and a real broker. The consumer is built directly where a test needs to see or break the
// acknowledgement, and through the application where it needs the wiring.

const sqs = new SQSClient({
  region: TEST_ENV.AWS_REGION,
  endpoint: TEST_ENV.SQS_ENDPOINT,
  credentials: { accessKeyId: TEST_ENV.AWS_ACCESS_KEY_ID, secretAccessKey: TEST_ENV.AWS_SECRET_ACCESS_KEY },
});
let world: SettlementWorld;
let queueUrl: string;

beforeAll(async () => {
  await provisionQueues();
  world = await SettlementWorld.create();
  queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUES.input }))).QueueUrl as string;
});
afterAll(async () => {
  await purge();
  sqs.destroy();
  await world.destroy();
});
// The queue is shared with every other test file, so each test starts and ends with it empty.
beforeEach(purge);
afterEach(purge);

async function purge(): Promise<void> {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
}

async function depth(): Promise<{ visible: number; inFlight: number }> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible),
  };
}

async function eventually(
  check: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const queueIsEmpty = async () => {
  const { visible, inFlight } = await depth();
  return visible + inFlight === 0;
};

function message(wallet: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const external = randomUUID();
  const { messageId = `msg-${randomUUID()}`, ...data } = overrides;
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: external,
      idempotencyKey: `provider-a:${external}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: "80.00", currency: "BRL" },
      ...data,
    },
  };
}

function send(body: unknown, group: string, dedup = randomUUID()) {
  return sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: group,
      MessageDeduplicationId: dedup,
    }),
  );
}

/** The real use case, with a record of what it answered, so a test can tell a replay from a first delivery. */
function spyOnUseCase(override?: (call: number) => void) {
  const results: SubmissionResult[] = [];
  let calls = 0;
  const useCase = {
    execute: async (...args: Parameters<SubmitWagerTransaction["execute"]>) => {
      override?.(++calls);
      const result = await world.useCase.execute(...args);
      results.push(result);
      return result;
    },
  } as unknown as SubmitWagerTransaction;
  return { useCase, results, calls: () => calls };
}

const started = (consumer: WagerQueueConsumer) => {
  consumer.onApplicationBootstrap();
  return consumer;
};

describe("a message from the queue", () => {
  test("is settled with the HTTP use case, and acknowledged only afterwards", async () => {
    const wallet = await world.openWallet("100.00");
    const { useCase, results } = spyOnUseCase();
    const consumer = started(new WagerQueueConsumer(sqs, useCase, 1));
    try {
      const body = message(wallet);
      await send(body, wallet.walletId);

      await eventually(queueIsEmpty, "the message to be acknowledged");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ status: "PROCESSED", idempotentReplay: false });
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
      const inbox = await world.sql("select 1 from inbox_messages where message_id = ?", [body.messageId]);
      expect(inbox).toHaveLength(1);
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  });

  test("that is a business rejection is acknowledged too: it is an answer", async () => {
    const wallet = await world.openWallet("10.00");
    const { useCase, results } = spyOnUseCase();
    const consumer = started(new WagerQueueConsumer(sqs, useCase, 1));
    try {
      await send(message(wallet), wallet.walletId);
      await eventually(queueIsEmpty, "the rejection to be acknowledged");
      expect(results[0]).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "10.00", version: 1 });
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  });

  test("delivered again, by the broker or by a provider, changes nothing", async () => {
    const wallet = await world.openWallet("100.00");
    const { useCase, results } = spyOnUseCase();
    const consumer = started(new WagerQueueConsumer(sqs, useCase, 1));
    try {
      const body = message(wallet);
      await send(body, wallet.walletId);
      await eventually(() => results.length === 1, "the first delivery");

      // The broker's own dedup would drop an identical send inside five minutes, so this one is a new send.
      await send(body, wallet.walletId);
      // And a provider resending the operation under a new message id.
      await send({ ...body, messageId: `msg-${randomUUID()}` }, wallet.walletId);
      await eventually(() => results.length === 3, "both redeliveries");
      await eventually(queueIsEmpty, "all of them to be acknowledged");

      expect(results.map((result) => result.idempotentReplay)).toEqual([false, true, true]);
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  });
});

describe("a worker killed after the commit and before the acknowledgement (§10)", () => {
  test("is redelivered to another worker and changes nothing", async () => {
    const wallet = await world.openWallet("100.00");
    const body = message(wallet);

    // Worker A commits, and its acknowledgement never gets through. This is what a kill between the two looks like
    // to the database and to the broker: the effect is stored and the message is still in flight.
    let lostHandle: string | undefined;
    const deaf = new Proxy(sqs, {
      get(client, property) {
        if (property !== "send")
          return Reflect.get(client, property).bind?.(client) ?? Reflect.get(client, property);
        return async (
          command: { constructor: { name: string }; input: { ReceiptHandle?: string } },
          ...rest: unknown[]
        ) => {
          if (command.constructor.name === "DeleteMessageCommand") {
            lostHandle = command.input.ReceiptHandle;
            throw new Error("killed before the acknowledgement");
          }
          return (client.send as (...args: unknown[]) => unknown)(command, ...rest);
        };
      },
    }) as unknown as SQSClient;
    const a = spyOnUseCase();
    const workerA = started(new WagerQueueConsumer(deaf, a.useCase, 1));
    await send(body, wallet.walletId);
    await eventually(() => lostHandle !== undefined, "worker A to commit and fail to acknowledge");
    await workerA.beforeApplicationShutdown();

    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    expect((await depth()).inFlight).toBe(1);

    // The visibility timeout would bring it back in 30 s; the test brings it back now.
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: lostHandle,
        VisibilityTimeout: 0,
      }),
    );
    const b = spyOnUseCase();
    const workerB = started(new WagerQueueConsumer(sqs, b.useCase, 1));
    try {
      await eventually(queueIsEmpty, "worker B to acknowledge the redelivery");
      expect(a.results.map((result) => result.idempotentReplay)).toEqual([false]);
      expect(b.results.map((result) => result.idempotentReplay)).toEqual([true]);
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
      await world.expectLedgerExplainsBalance(wallet.walletId);
    } finally {
      await workerB.beforeApplicationShutdown();
    }
  });
});

describe("a message that is not acknowledged", () => {
  test("a transient failure leaves it in the queue, and the rest of its wallet's messages untouched", async () => {
    const wallet = await world.openWallet("100.00");
    const first = message(wallet, { money: { amount: "10.00", currency: "BRL" } });
    const second = message(wallet, { money: { amount: "20.00", currency: "BRL" } });
    // Both in the queue before anyone reads, so one receive gets both of this wallet's messages.
    await send(first, wallet.walletId);
    await send(second, wallet.walletId);

    const { useCase, calls, results } = spyOnUseCase((call) => {
      if (call === 1) throw new TransientFailureError("the database is away");
    });
    const consumer = started(new WagerQueueConsumer(sqs, useCase, 1));
    try {
      await eventually(() => calls() >= 1, "the first attempt");
      await Bun.sleep(500);

      expect(calls()).toBe(1);
      expect(results).toEqual([]);
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });
      expect((await depth()).visible + (await depth()).inFlight).toBe(2);
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  });

  test.each([
    ["malformed JSON", () => "{not json"],
    ["an unknown type", (w: { walletId: string; playerId: string }) => ({ ...message(w), type: "Other" })],
    [
      "an invalid payload",
      (w: { walletId: string; playerId: string }) =>
        message(w, { money: { amount: "1.5", currency: "BRL" } }),
    ],
    ["an OPENING", (w: { walletId: string; playerId: string }) => message(w, { kind: "OPENING" })],
    ["a wallet that does not exist", () => message({ walletId: randomUUID(), playerId: randomUUID() })],
  ])("%s is not acknowledged and changes nothing", async (_name, build) => {
    const wallet = await world.openWallet("100.00");
    const { useCase, results } = spyOnUseCase();
    const consumer = started(new WagerQueueConsumer(sqs, useCase, 1));
    try {
      await send(build(wallet), wallet.walletId);
      await eventually(async () => (await depth()).inFlight === 1, "the message to be received");
      await Bun.sleep(300);

      expect((await depth()).inFlight).toBe(1);
      expect(
        results.filter((result) => result.idempotentReplay === false && result.status !== "REJECTED"),
      ).toEqual([]);
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  });

  test("a message id reused with other content is not acknowledged either (INT-17)", async () => {
    const wallet = await world.openWallet("100.00");
    const { useCase } = spyOnUseCase();
    const consumer = started(new WagerQueueConsumer(sqs, useCase, 1));
    try {
      const original = message(wallet);
      await send(original, wallet.walletId);
      await eventually(queueIsEmpty, "the original");

      const liar = message(wallet, {
        messageId: original.messageId,
        money: { amount: "5.00", currency: "BRL" },
      });
      await send(liar, wallet.walletId);
      await eventually(async () => (await depth()).inFlight === 1, "the second to be received");
      await Bun.sleep(300);

      expect((await depth()).inFlight).toBe(1);
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  });
});

describe("the application", () => {
  test("a process without the consumer role leaves the queue alone, and one with it settles the message", async () => {
    const wallet = await world.openWallet("100.00");
    await send(message(wallet), wallet.walletId);

    const apiOnly = await startApp(world.databaseUrl(), { roles: "api" });
    await Bun.sleep(1_000);
    expect((await depth()).visible).toBe(1);
    await apiOnly.stop();

    const consumer = await startApp(world.databaseUrl(), { roles: "consumer" });
    try {
      await eventually(queueIsEmpty, "the consumer role to settle it");
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
      expect(consumer.logs.some((line) => line.message === "Message settled")).toBe(true);
    } finally {
      await consumer.stop();
    }
  }, 30_000);

  test("stopping takes at most one poll, and leaves no open poll to swallow the next message", async () => {
    const consumer = await startApp(world.databaseUrl(), {
      roles: "consumer",
      env: { QUEUE_WAIT_SECONDS: "1" },
    });
    await Bun.sleep(300);
    const stopping = performance.now();
    await consumer.stop();
    expect(performance.now() - stopping).toBeLessThan(3_000);

    // A cancelled poll would take this message and hide it for the visibility timeout (30 s).
    const wallet = await world.openWallet("100.00");
    await send(message(wallet), wallet.walletId);
    await Bun.sleep(300);
    expect(await depth()).toEqual({ visible: 1, inFlight: 0 });
  }, 30_000);
});
