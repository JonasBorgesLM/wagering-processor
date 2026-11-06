import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ChangeMessageVisibilityCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { TransientFailureError } from "../../src/wagering/application/errors";
import { WagerQueueConsumer } from "../../src/wagering/infrastructure/messaging/wager-queue-consumer";
import { startApp } from "../support/app";
import {
  depth,
  eventually,
  FAST,
  inputUrl,
  message,
  purge,
  queueIsEmpty,
  send,
  setUpQueues,
  spyOnUseCase as spy,
  sqs,
  started,
} from "../support/consumer-harness";
import { SettlementWorld } from "../support/settlement";

// Real PostgreSQL and a real broker. The consumer is built directly where a test needs to see or break the
// acknowledgement, and through the application where it needs the wiring.

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

describe("a message from the queue", () => {
  test("is settled with the HTTP use case, and acknowledged only afterwards", async () => {
    const wallet = await world.openWallet("100.00");
    const { useCase, results } = spyOnUseCase();
    const consumer = started(new WagerQueueConsumer(sqs, useCase, FAST));
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
    const consumer = started(new WagerQueueConsumer(sqs, useCase, FAST));
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
    const consumer = started(new WagerQueueConsumer(sqs, useCase, FAST));
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
    const workerA = started(new WagerQueueConsumer(deaf, a.useCase, FAST));
    await send(body, wallet.walletId);
    await eventually(() => lostHandle !== undefined, "worker A to commit and fail to acknowledge");
    await workerA.beforeApplicationShutdown();

    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    expect((await depth()).inFlight).toBe(1);

    // The visibility timeout would bring it back in 30 s; the test brings it back now.
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: inputUrl,
        ReceiptHandle: lostHandle,
        VisibilityTimeout: 0,
      }),
    );
    const b = spyOnUseCase();
    const workerB = started(new WagerQueueConsumer(sqs, b.useCase, FAST));
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

describe("a message that fails transiently", () => {
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
    // A long backoff, so the message stays hidden for the whole test and the group stays blocked.
    const slow = { ...FAST, backoff: { baseSeconds: 30, capSeconds: 30 } };
    const consumer = started(new WagerQueueConsumer(sqs, useCase, slow));
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
