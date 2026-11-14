import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { createSqsClient } from '../../src/infra/messaging/sqs';

export const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566';

export function testSqsClient(): SQSClient {
  return createSqsClient({ endpoint: SQS_ENDPOINT, region: 'us-east-1' });
}

export interface TestQueues {
  queueName: string;
  dlqName: string;
  eventsQueueName: string;
  queueUrl: string;
  dlqUrl: string;
  eventsUrl: string;
}

export async function createTestQueues(client: SQSClient, redriveMaxReceiveCount = 10): Promise<TestQueues> {
  const prefix = `t${randomUUID().slice(0, 8)}`;
  const dlqName = `${prefix}-dlq.fifo`;
  const queueName = `${prefix}-in.fifo`;
  const eventsQueueName = `${prefix}-events.fifo`;
  const dlq = await client.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true' } }));
  const dlqArn = (
    await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes?.QueueArn;
  const main = await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(redriveMaxReceiveCount) }),
      },
    }),
  );
  const events = await client.send(new CreateQueueCommand({ QueueName: eventsQueueName, Attributes: { FifoQueue: 'true' } }));
  return {
    queueName,
    dlqName,
    eventsQueueName,
    queueUrl: main.QueueUrl ?? '',
    dlqUrl: dlq.QueueUrl ?? '',
    eventsUrl: events.QueueUrl ?? '',
  };
}

/** Cada envio tem deduplication id próprio: simula redelivery do broker mesmo com o mesmo messageId. */
export async function sendWagerMessage(
  client: SQSClient,
  queueUrl: string,
  data: Record<string, unknown>,
  opts: { messageId?: string; groupId?: string; raw?: string } = {},
): Promise<string> {
  const messageId = opts.messageId ?? `msg-${randomUUID()}`;
  const body =
    opts.raw ??
    JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data });
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: opts.groupId ?? String(data.walletId ?? 'g'),
      MessageDeduplicationId: randomUUID(),
    }),
  );
  return messageId;
}

export async function drain(client: SQSClient, queueUrl: string, waitSeconds = 1): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const res = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
      }),
    );
    const messages = res.Messages ?? [];
    if (messages.length === 0) return all;
    all.push(...messages);
    await client.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
      }),
    );
  }
}

export async function queueDepth(client: SQSClient, queueUrl: string): Promise<number> {
  const res = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

export async function waitFor<T>(check: () => Promise<T | undefined | false>, timeoutMs = 20_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await Bun.sleep(intervalMs);
  }
}
