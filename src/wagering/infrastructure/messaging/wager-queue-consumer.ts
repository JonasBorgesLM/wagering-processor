import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { QUEUES } from "../../../platform/config/config";
import type { SubmitWagerTransaction } from "../../application/submit-wager-transaction";
import { classifyFailure } from "./classify-failure";
import { CONSUMER_NAME, parseWagerMessage } from "./wager-message";

const RETRY_DELAY_MS = 1_000;

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
    private readonly waitSeconds: number,
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
  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  private get stopping(): boolean {
    return this.abort.signal.aborted;
  }

  private async run(): Promise<void> {
    const queueUrl = await this.resolveQueue();
    while (queueUrl && !this.stopping) {
      let messages: Message[];
      try {
        const received = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.waitSeconds,
            MessageSystemAttributeNames: ["MessageGroupId"],
          }),
        );
        messages = received.Messages ?? [];
      } catch (error) {
        if (this.stopping) return;
        this.logger.warn("Receiving failed; trying again", { error: describe(error) });
        await this.pause();
        continue;
      }
      await this.handleBatch(queueUrl, messages);
    }
  }

  /** The queue may not exist yet when this process starts, and a missing broker is not a reason to die. */
  private async resolveQueue(): Promise<string | undefined> {
    while (!this.stopping) {
      try {
        const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: QUEUES.input }), {
          abortSignal: this.abort.signal,
        });
        if (QueueUrl) return QueueUrl;
      } catch (error) {
        if (this.stopping) return undefined;
        this.logger.warn("Input queue not reachable yet", { error: describe(error) });
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
  private async handleBatch(queueUrl: string, messages: Message[]): Promise<void> {
    const blocked = new Set<string>();
    for (const message of messages) {
      if (this.stopping) return;
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? "";
      if (blocked.has(group)) continue;
      if (!(await this.handle(queueUrl, message))) blocked.add(group);
    }
  }

  /** Whether the message is finished with, so the next of its group may go. */
  private async handle(queueUrl: string, message: Message): Promise<boolean> {
    try {
      const { messageId, command } = parseWagerMessage(message.Body);
      const result = await this.useCase.execute(command, { consumerName: CONSUMER_NAME, messageId });
      this.logger.log(result.idempotentReplay ? "Message was a replay" : "Message settled", {
        messageId,
        transactionId: result.transactionId,
        status: result.status,
      });
    } catch (error) {
      const action = classifyFailure(error);
      // The first attempt at a fix for every unknown failure is to read the log, so it says what it was.
      this.logger[action === "retry" ? "warn" : "error"](
        action === "retry" ? "Message left for redelivery" : "Message cannot be processed",
        { messageId: message.MessageId, error: describe(error) },
      );
      return false;
    }

    try {
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    } catch (error) {
      // Committed but not acknowledged: it will be delivered again and found in the inbox. Nothing is lost.
      this.logger.warn("Acknowledging failed; the message will be redelivered", { error: describe(error) });
    }
    return true;
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

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
