import { randomUUID } from "node:crypto";
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { QUEUES } from "../../src/platform/config/config";
import type {
  SubmissionResult,
  SubmitWagerTransaction,
} from "../../src/wagering/application/submit-wager-transaction";
import type {
  ConsumerOptions,
  WagerQueueConsumer,
} from "../../src/wagering/infrastructure/messaging/wager-queue-consumer";
import { TEST_ENV } from "./env";
import { provisionQueues } from "./queues";
import type { SettlementWorld } from "./settlement";

// Shared by the tests that run the consumer against the real broker. The queues are shared with every other test
// file, so each test starts and ends with them empty.

export const sqs = new SQSClient({
  region: TEST_ENV.AWS_REGION,
  endpoint: TEST_ENV.SQS_ENDPOINT,
  credentials: { accessKeyId: TEST_ENV.AWS_ACCESS_KEY_ID, secretAccessKey: TEST_ENV.AWS_SECRET_ACCESS_KEY },
});

/** Short polls and a one-second backoff, so a test does not wait out the production defaults. */
export const FAST: ConsumerOptions = {
  waitSeconds: 1,
  backoff: { baseSeconds: 1, capSeconds: 1 },
  maxReceives: 5,
};

export let inputUrl: string;
export let deadLetterUrl: string;

export async function setUpQueues(): Promise<void> {
  await provisionQueues();
  inputUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUES.input }))).QueueUrl as string;
  deadLetterUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUES.deadLetter })))
    .QueueUrl as string;
}

export async function purge(): Promise<void> {
  for (const QueueUrl of [inputUrl, deadLetterUrl]) {
    await sqs.send(new PurgeQueueCommand({ QueueUrl })).catch(() => undefined);
  }
}

export async function depth(queueUrl = inputUrl): Promise<{ visible: number; inFlight: number }> {
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

export async function eventually(
  check: () => Promise<boolean> | boolean,
  /** What was being waited for. A function is asked at the end, so the message can say what was seen meanwhile. */
  what: string | (() => string),
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
}

export const queueIsEmpty = async (queueUrl = inputUrl) => {
  const { visible, inFlight } = await depth(queueUrl);
  return visible + inFlight === 0;
};

export function message(
  wallet: { walletId: string; playerId: string },
  overrides: Record<string, unknown> = {},
) {
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

export function send(body: unknown, group: string, dedup = randomUUID()) {
  return sqs.send(
    new SendMessageCommand({
      QueueUrl: inputUrl,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: group,
      MessageDeduplicationId: dedup,
    }),
  );
}

/** What is in the dead-letter queue, read and left in flight (a test purges afterwards). */
export async function readDeadLetters() {
  const received = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: deadLetterUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ["All"],
    }),
  );
  return (received.Messages ?? []).map((m) => ({
    body: m.Body ?? "",
    kind: m.MessageAttributes?.FailureKind?.StringValue,
    reason: m.MessageAttributes?.FailureReason?.StringValue,
    receives: m.MessageAttributes?.Receives?.StringValue,
  }));
}

/** The real use case, with a record of what it answered, so a test can tell a replay from a first delivery. */
export function spyOnUseCase(world: SettlementWorld, override?: (call: number) => void) {
  const results: SubmissionResult[] = [];
  let calls = 0;
  const useCase = {
    execute: async (...args: Parameters<SubmitWagerTransaction["execute"]>) => {
      calls += 1;
      override?.(calls);
      const result = await world.useCase.execute(...args);
      results.push(result);
      return result;
    },
  } as unknown as SubmitWagerTransaction;
  return { useCase, results, calls: () => calls };
}

export const started = (consumer: WagerQueueConsumer) => {
  consumer.onApplicationBootstrap();
  return consumer;
};

export let eventsUrl: string;

/** Also needs the events queue: for the tests that follow an event from the outbox to the broker. */
export async function setUpEventsQueue(): Promise<void> {
  eventsUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUES.events }))).QueueUrl as string;
}

export async function purgeEvents(): Promise<void> {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: eventsUrl })).catch(() => undefined);
}

/** Every event in the events queue now, deleted as it is read, as the ids and types the envelopes carry. */
export async function drainEvents(): Promise<
  Array<{ eventId: string; eventType: string; aggregateId: string }>
> {
  const all: Array<{ eventId: string; eventType: string; aggregateId: string }> = [];
  for (let empty = 0; empty < 2; ) {
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: eventsUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    const messages = received.Messages ?? [];
    empty = messages.length === 0 ? empty + 1 : 0;
    for (const message of messages) {
      const body = JSON.parse(message.Body ?? "{}") as {
        eventId: string;
        eventType: string;
        aggregateId: string;
      };
      all.push({ eventId: body.eventId, eventType: body.eventType, aggregateId: body.aggregateId });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return all;
}
