import { describe, expect, test } from "bun:test";
import type { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { OutboxEntry } from "../../../src/wagering/application/ports";
import { SqsEventPublisher } from "../../../src/wagering/infrastructure/messaging/sqs-event-publisher";

// Requirements: FR-90, FR-96. How a batch of outbox entries becomes one call to the broker, and how the broker's
// answer for each entry becomes accepted or refused. The call itself, against the real broker, is in the
// integration suite; a real broker does not refuse an entry on demand, so the refusal is made here.

const entry = (id: string, wallet: string): OutboxEntry => ({
  id,
  aggregateId: wallet,
  eventType: "WalletBalanceChanged",
  payload: { eventId: id, aggregateId: wallet },
  attempts: 1,
});

function fakeClient(answer: {
  Successful?: Array<{ Id: string }>;
  Failed?: Array<{ Id: string; Code?: string; Message?: string }>;
}) {
  const sent: SendMessageBatchCommand[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: unknown }) => {
      if (command.constructor.name === "GetQueueUrlCommand") return { QueueUrl: "http://broker/queue" };
      sent.push(command as SendMessageBatchCommand);
      return answer;
    },
  } as unknown as SQSClient;
  return { client, sent };
}

describe("one call to the broker for a batch of events", () => {
  test("carries each event as a message of its wallet's group, deduplicated by its own id, in order", async () => {
    const { client, sent } = fakeClient({ Successful: [{ Id: "e1" }, { Id: "e2" }] });
    await new SqsEventPublisher(client).publishBatch([entry("e1", "w1"), entry("e2", "w1")]);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.input.QueueUrl).toBe("http://broker/queue");
    expect(sent[0]?.input.Entries).toEqual([
      {
        Id: "e1",
        MessageBody: '{"eventId":"e1","aggregateId":"w1"}',
        MessageGroupId: "w1",
        MessageDeduplicationId: "e1",
      },
      {
        Id: "e2",
        MessageBody: '{"eventId":"e2","aggregateId":"w1"}',
        MessageGroupId: "w1",
        MessageDeduplicationId: "e2",
      },
    ]);
  });

  test("what the broker accepted is accepted, and what it refused is refused with why", async () => {
    const { client } = fakeClient({
      Successful: [{ Id: "e1" }, { Id: "e3" }],
      Failed: [{ Id: "e2", Code: "InternalError", Message: "try later" }],
    });
    const result = await new SqsEventPublisher(client).publishBatch([
      entry("e1", "w1"),
      entry("e2", "w1"),
      entry("e3", "w2"),
    ]);

    expect(result.accepted).toEqual(["e1", "e3"]);
    expect(result.rejected.map((r) => r.id)).toEqual(["e2"]);
    expect(String(result.rejected[0]?.error)).toContain("InternalError: try later");
  });

  test("an answer with nothing in it accepts nothing", async () => {
    const { client } = fakeClient({});
    expect(await new SqsEventPublisher(client).publishBatch([entry("e1", "w1")])).toEqual({
      accepted: [],
      rejected: [],
    });
  });
});
