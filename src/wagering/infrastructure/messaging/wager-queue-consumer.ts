import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { QUEUES } from "../../../platform/config/config";
import { type BackoffPolicy, backoffSeconds } from "../../../platform/resilience/backoff";
import { ApplicationError } from "../../application/errors";
import { NO_METRICS, type WageringMetrics } from "../../application/ports";
import type { SubmitWagerTransaction } from "../../application/submit-wager-transaction";
import { classifyFailure } from "./classify-failure";
import { CONSUMER_NAME, parseWagerMessage } from "./wager-message";

const RETRY_DELAY_MS = 1_000;

interface Queues {
  input: string;
  deadLetter: string;
}

export interface ConsumerOptions {
  /** How long one poll waits for a message. Also the longest stopping can take. */
  waitSeconds: number;
  backoff: BackoffPolicy;
  /** Deliveries a message gets before it is dead-lettered. The queue's redrive policy says the same number. */
  maxReceives: number;
}

/**
 * Reads the input queue and settles each message with the same use case as the HTTP endpoint (§10).
 *
 * The order is the guarantee: the message is deleted only after the use case has returned, and it returns only
 * after COMMIT. A crash anywhere before the delete redelivers the message, and the inbox and the idempotency key
 * make the second delivery change nothing (NFR-04, NFR-05).
 */
export class WagerQueueConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WagerQueueConsumer.name);
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly useCase: SubmitWagerTransaction,
    private readonly options: ConsumerOptions,
    private readonly drain: { begin(signal?: string): void } = { begin: () => undefined },
    private readonly metrics: WageringMetrics = NO_METRICS,
  ) {}

  onApplicationBootstrap(): void {
    // Not awaited: Nest would wait for a loop that never ends before it started listening.
    this.loop = this.run();
  }

  /**
   * Stops polling and lets the message in hand finish; the rest of its batch stays in the queue.
   *
   * It waits for the poll in progress instead of cancelling it. A cancelled long poll is still open at the broker,
   * which hands the next message to a connection nobody is listening on and hides it until its visibility runs out.
   * Observed on the emulator, and AWS documents the same hazard. That is why a poll is short (`QUEUE_WAIT_SECONDS`):
   * it bounds how long stopping can take.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    // Before the wait below: readiness must fail while the message in hand finishes, not after (FR-80).
    this.drain.begin(signal);
    this.abort.abort();
    await this.loop;
  }

  private get stopping(): boolean {
    return this.abort.signal.aborted;
  }

  private async run(): Promise<void> {
    const queues = await this.resolveQueues();
    while (queues && !this.stopping) {
      let messages: Message[];
      try {
        const received = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queues.input,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.options.waitSeconds,
            MessageSystemAttributeNames: ["MessageGroupId", "ApproximateReceiveCount"],
          }),
        );
        messages = received.Messages ?? [];
      } catch (error) {
        if (this.stopping) return;
        this.logger.warn("Receiving failed; trying again", { error: describe(error) });
        await this.pause();
        continue;
      }
      await this.handleBatch(queues, messages);
    }
  }

  /** The queues may not exist yet when this process starts, and a missing broker is not a reason to die. */
  private async resolveQueues(): Promise<Queues | undefined> {
    while (!this.stopping) {
      try {
        const url = async (name: string) =>
          (
            await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }), {
              abortSignal: this.abort.signal,
            })
          ).QueueUrl;
        const [input, deadLetter] = await Promise.all([url(QUEUES.input), url(QUEUES.deadLetter)]);
        if (input && deadLetter) return { input, deadLetter };
      } catch (error) {
        if (this.stopping) return undefined;
        this.logger.warn("Queues not reachable yet", { error: describe(error) });
      }
      await this.pause();
    }
    return undefined;
  }

  /**
   * In order, because a FIFO queue delivers a wallet's messages in order and this keeps it so. When one fails, the
   * rest of its group in this batch is left alone: processing a later message of a wallet over an earlier one that
   * is waiting to be retried would only produce reorderings the settlement has to absorb (NFR-05). Left unacked,
   * they come back with the failed one.
   */
  private async handleBatch(queues: Queues, messages: Message[]): Promise<void> {
    const blocked = new Set<string>();
    for (const [index, message] of messages.entries()) {
      if (this.stopping) {
        await this.release(queues.input, messages.slice(index));
        return;
      }
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? "";
      if (blocked.has(group)) continue;
      if (!(await this.handle(queues, message))) blocked.add(group);
    }
  }

  /**
   * Makes messages that were received and not started visible again at once (FR-80). Left alone they would stay
   * hidden for the whole visibility timeout, and the wallets behind them would wait with them. If this fails the
   * timeout does the same later: shutdown is an optimization of recovery, not the guarantee.
   */
  private async release(queueUrl: string, messages: Message[]): Promise<void> {
    await Promise.all(
      messages.map((message) =>
        this.sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          )
          .catch((error: unknown) =>
            this.logger.warn("Returning a message failed; its visibility will run out", {
              messageId: message.MessageId,
              error: describe(error),
            }),
          ),
      ),
    );
    this.logger.log(`Returned ${messages.length} unstarted message(s) to the queue`);
  }

  /** Whether the message is finished with, so the next of its wallet may go. */
  private async handle(queues: Queues, message: Message): Promise<boolean> {
    try {
      const { messageId, command } = parseWagerMessage(message.Body);
      const result = await this.useCase.execute(command, { consumerName: CONSUMER_NAME, messageId });
      // The fields that tie this line to the message, the transaction and the wallet. Never the amount, the player,
      // the round or the key: those are the payload (SR-01).
      this.logger.log(result.idempotentReplay ? "Message was a replay" : "Message settled", {
        correlationId: command.correlationId,
        messageId,
        transactionId: result.transactionId,
        walletId: command.walletId,
        providerId: command.providerId,
        status: result.status,
        failureCode: result.failureCode,
      });
    } catch (error) {
      return this.failed(queues, message, error);
    }
    await this.acknowledge(queues.input, message);
    return true;
  }

  /**
   * A permanent failure goes to the DLQ at once, and so does a message whose deliveries ran out: retrying either
   * only delays the verdict. A transient one is made invisible for a backoff that grows with the deliveries, so
   * a database that is away is not hit again at once by every message that failed on it.
   */
  private async failed(queues: Queues, message: Message, error: unknown): Promise<boolean> {
    const receives = Number(message.Attributes?.ApproximateReceiveCount ?? 1); // money-check: not-money a delivery count
    const permanent = classifyFailure(error) === "dead-letter";
    const exhausted = !permanent && receives >= this.options.maxReceives;

    if (permanent || exhausted) {
      this.logger.error(permanent ? "Message cannot be processed" : "Message ran out of attempts", {
        messageId: message.MessageId,
        error: describeForLog(error),
      });
      return this.deadLetter(
        queues,
        message,
        permanent ? "permanent" : "attempts-exhausted",
        error,
        receives,
      );
    }

    const delay = backoffSeconds(receives, this.options.backoff);
    this.metrics.retried("consumer");
    this.logger.warn(`Message will be retried in ${delay}s`, {
      messageId: message.MessageId,
      error: describeForLog(error),
    });
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.input,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delay,
        }),
      );
    } catch (visibilityError) {
      // The default visibility timeout then applies: later, but still a retry.
      this.logger.warn("Setting the backoff failed", { error: describe(visibilityError) });
    }
    return false;
  }

  /**
   * Copies the message to the DLQ with the reason, and only then deletes it, so a crash in between leaves a
   * duplicate in the DLQ at worst (its deduplication id is the original message id) and never a lost message.
   * If the copy fails the message stays where it is and is delivered again.
   */
  private async deadLetter(
    queues: Queues,
    message: Message,
    kind: "permanent" | "attempts-exhausted",
    error: unknown,
    receives: number,
  ): Promise<boolean> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.deadLetter,
          MessageBody: message.Body ?? "",
          MessageGroupId: message.Attributes?.MessageGroupId ?? message.MessageId,
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            FailureKind: { DataType: "String", StringValue: kind },
            FailureReason: { DataType: "String", StringValue: describe(error).slice(0, 1000) },
            Receives: { DataType: "Number", StringValue: String(receives) },
          },
        }),
      );
    } catch (sendError) {
      this.logger.error("Dead-lettering failed; the message stays in the queue", {
        messageId: message.MessageId,
        error: describe(sendError),
      });
      return false;
    }
    this.metrics.deadLettered(kind);
    await this.acknowledge(queues.input, message);
    return true;
  }

  private async acknowledge(queueUrl: string, message: Message): Promise<void> {
    try {
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    } catch (error) {
      // Committed but not acknowledged: it will be delivered again and found in the inbox. Nothing is lost.
      this.logger.warn("Acknowledging failed; the message will be redelivered", { error: describe(error) });
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, RETRY_DELAY_MS);
      this.abort.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

/**
 * What a log line may say about why a message failed (SR-01). An application error says its code and not its
 * message, because the message names what the sender sent: `IDEMPOTENCY_CONFLICT` and not "key provider-a:tx-1 was
 * used with a different payload", `VALIDATION_ERROR` and not a field name the sender chose. The full reason still
 * goes to the DLQ, next to the body, which carries the whole payload anyway. Other errors are the system's own
 * (a lost connection, a bug) and are described in full, since that is what diagnosing them needs.
 */
export function describeForLog(error: unknown): string {
  if (error instanceof ApplicationError) return `${error.name} (${error.code})`;
  return describe(error);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
