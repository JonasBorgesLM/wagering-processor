import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { QUEUES } from "../../../platform/config/config";
import type { EventPublisher, OutboxEntry, PublishBatchResult } from "../../application/ports";

/** Every call to the broker is bounded (NFR-11); a publisher that waits forever holds its batch's leases hostage. */
const SEND_TIMEOUT_MS = 5_000;

/**
 * Publishes to `wagering-events.fifo` (INT-19). The deduplication id is the `eventId`, so the broker drops a
 * repeat inside its five-minute window, and the group is the wallet, so a wallet's events keep their order
 * (ADR-0007). Consumers still deduplicate on `eventId` themselves: the window ends, and the guarantee is theirs
 * (IR-03, NFR-05).
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(private readonly sqs: SQSClient) {}

  async publishBatch(entries: readonly OutboxEntry[]): Promise<PublishBatchResult> {
    const queueUrl = await this.resolveQueue();
    const answer = await this.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        // Within a call the broker keeps the order of the entries per group, so a wallet's events keep theirs.
        Entries: entries.map((entry) => ({
          Id: entry.id,
          MessageBody: JSON.stringify(entry.payload),
          MessageGroupId: entry.aggregateId,
          MessageDeduplicationId: entry.id,
        })),
      }),
      { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
    );
    return {
      accepted: (answer.Successful ?? []).map((sent) => sent.Id as string),
      rejected: (answer.Failed ?? []).map((failed) => ({
        id: failed.Id as string,
        error: new Error(
          `${failed.Code ?? "SendFailed"}: ${failed.Message ?? "the broker refused the message"}`,
        ),
      })),
    };
  }

  private async resolveQueue(): Promise<string> {
    if (this.queueUrl) return this.queueUrl;
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: QUEUES.events }), {
      abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!QueueUrl) throw new Error(`queue ${QUEUES.events} has no url`);
    this.queueUrl = QueueUrl;
    return QueueUrl;
  }
}
