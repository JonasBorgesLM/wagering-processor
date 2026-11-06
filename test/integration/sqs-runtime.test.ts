import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { TEST_ENV } from "../support/env";

// Requirements: IR-01, IR-02.

// Broker semantics the consumer design relies on. An emulator can differ from
// AWS here, and every line of consumer logic would silently depend on the difference.

const sqs = new SQSClient({
  region: TEST_ENV.AWS_REGION,
  endpoint: TEST_ENV.SQS_ENDPOINT,
  credentials: { accessKeyId: TEST_ENV.AWS_ACCESS_KEY_ID, secretAccessKey: TEST_ENV.AWS_SECRET_ACCESS_KEY },
});
const suffix = randomUUID().slice(0, 8);
const MAX_RECEIVE = 2;
let inputUrl: string;
let dlqUrl: string;

const receive = async (queueUrl: string, max = 10, waitSeconds = 0): Promise<Message[]> => {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: waitSeconds,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );
  return result.Messages ?? [];
};

const send = (group: string, body: string, dedup = randomUUID()) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: inputUrl,
      MessageBody: body,
      MessageGroupId: group,
      MessageDeduplicationId: dedup,
    }),
  );

const drain = async () => {
  for (let messages = await receive(inputUrl); messages.length > 0; messages = await receive(inputUrl)) {
    for (const message of messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: inputUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
};

beforeAll(async () => {
  const fifo = { FifoQueue: "true", ContentBasedDeduplication: "false" };
  const dlq = await sqs.send(
    new CreateQueueCommand({ QueueName: `contract-dlq-${suffix}.fifo`, Attributes: fifo }),
  );
  dlqUrl = dlq.QueueUrl as string;
  const arn = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
  );
  const input = await sqs.send(
    new CreateQueueCommand({
      QueueName: `contract-input-${suffix}.fifo`,
      Attributes: {
        ...fifo,
        VisibilityTimeout: "1",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: arn.Attributes?.QueueArn,
          maxReceiveCount: String(MAX_RECEIVE),
        }),
      },
    }),
  );
  inputUrl = input.QueueUrl as string;
});

afterAll(async () => {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: inputUrl }));
  await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
  sqs.destroy();
});

describe("FIFO queue", () => {
  test("drops a repeated deduplication id", async () => {
    const dedup = randomUUID();
    await send("dedup", "first", dedup);
    await send("dedup", "second", dedup);
    const messages = await receive(inputUrl);
    expect(messages.map((message) => message.Body)).toEqual(["first"]);
    await drain();
    await Bun.sleep(1100);
    await drain();
  });

  test("holds a group while a message is in flight, and leaves other groups free", async () => {
    await send("wallet-a", "a1");
    await send("wallet-a", "a2");
    const [first] = await receive(inputUrl, 1);
    expect(first?.Body).toBe("a1");
    await send("wallet-b", "b1");
    const next = await receive(inputUrl);
    expect(next.map((message) => message.Body)).toEqual(["b1"]);
    for (const message of [first, ...next]) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: inputUrl, ReceiptHandle: message?.ReceiptHandle }));
    }
    const [second] = await receive(inputUrl, 1);
    expect(second?.Body).toBe("a2");
    await sqs.send(new DeleteMessageCommand({ QueueUrl: inputUrl, ReceiptHandle: second?.ReceiptHandle }));
  });

  test("FR-80: returning visibility redelivers at once, and the receive count grows", async () => {
    await send("visibility", "v1");
    const [first] = await receive(inputUrl, 1);
    expect(first?.Attributes?.ApproximateReceiveCount).toBe("1");
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: inputUrl,
        ReceiptHandle: first?.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
    const [second] = await receive(inputUrl, 1);
    expect(second?.Body).toBe("v1");
    expect(second?.Attributes?.ApproximateReceiveCount).toBe("2");
    await sqs.send(new DeleteMessageCommand({ QueueUrl: inputUrl, ReceiptHandle: second?.ReceiptHandle }));
  });

  test("moves a message to the DLQ once maxReceiveCount is exceeded", async () => {
    await send("poison", "p1");
    for (let attempt = 1; attempt <= MAX_RECEIVE; attempt++) {
      const [message] = await receive(inputUrl, 1, 2);
      expect(message?.Body).toBe("p1");
      await Bun.sleep(1100);
    }
    expect(await receive(inputUrl, 1, 1)).toEqual([]);
    const [dead] = await receive(dlqUrl, 1, 2);
    expect(dead?.Body).toBe("p1");
  }, 15_000);
});
