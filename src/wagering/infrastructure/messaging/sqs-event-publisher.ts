import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { QUEUES } from "../../../platform/config/config";
import type { EventPublisher, OutboxEntry } from "../../application/ports";

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

  async publish(entry: OutboxEntry): Promise<void> {
    const queueUrl = await this.resolveQueue();
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(entry.payload),
        MessageGroupId: entry.aggregateId,
        MessageDeduplicationId: entry.id,
      }),
      { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
    );
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
