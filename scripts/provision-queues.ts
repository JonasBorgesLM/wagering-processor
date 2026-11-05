import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig, QUEUES } from "../src/platform/config/config";

// Local infrastructure setup: in a deployed environment these queues belong to IaC.
const MAX_RECEIVE_COUNT = "5";
const VISIBILITY_TIMEOUT = "30";

const config = loadConfig();
const sqs = new SQSClient({ region: config.awsRegion, endpoint: config.sqsEndpoint });

const fifo = { FifoQueue: "true", ContentBasedDeduplication: "false" };

const dlq = await sqs.send(new CreateQueueCommand({ QueueName: QUEUES.deadLetter, Attributes: fifo }));
const dlqAttributes = await sqs.send(
  new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ["QueueArn"] }),
);

await sqs.send(
  new CreateQueueCommand({
    QueueName: QUEUES.input,
    Attributes: {
      ...fifo,
      VisibilityTimeout: VISIBILITY_TIMEOUT,
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqAttributes.Attributes?.QueueArn,
        maxReceiveCount: MAX_RECEIVE_COUNT,
      }),
    },
  }),
);
await sqs.send(new CreateQueueCommand({ QueueName: QUEUES.events, Attributes: fifo }));
sqs.destroy();
console.log(JSON.stringify({ level: "info", message: "Queues provisioned", queues: Object.values(QUEUES) }));
