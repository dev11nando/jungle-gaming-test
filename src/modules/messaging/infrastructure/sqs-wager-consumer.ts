import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { METRIC, type Metrics } from '../../../shared/application/metrics';
import { retryVisibilitySeconds, type HandleOutcome, type WagerMessageHandler } from '../application/wager-message-handler';
import { sleep, type QueueUrls } from './sqs';

export interface ConsumerOptions {
  queueName: string;
  dlqName: string;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds: number;
  batchSize?: number;
  shutdownGraceMs?: number;
  /** Ponto de injeção de falha para testes de crash entre commit e ack. */
  beforeAck?: (message: Message, outcome: HandleOutcome) => Promise<void> | void;
}

export class SqsWagerConsumer {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private running = false;
  private stopping = false;
  private loop?: Promise<void>;
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly client: SQSClient,
    private readonly urls: QueueUrls,
    private readonly handler: WagerMessageHandler,
    private readonly metrics: Metrics,
    private readonly options: ConsumerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.running = false;
    this.abort.abort();
    const grace = this.options.shutdownGraceMs ?? 20_000;
    await Promise.race([Promise.allSettled([this.loop, ...this.inFlight]), sleep(grace)]);
  }

  private async run(): Promise<void> {
    const queueUrl = await this.retryForever(() => this.urls.get(this.options.queueName));
    while (this.running) {
      let messages: Message[] = [];
      try {
        const res = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: this.options.batchSize ?? 10,
            WaitTimeSeconds: this.options.waitTimeSeconds,
            VisibilityTimeout: this.options.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = res.Messages ?? [];
      } catch (error) {
        if (this.abort.signal.aborted) break;
        this.logger.warn({ msg: 'sqs receive failed', error: errorName(error) });
        await sleep(1_000, this.abort.signal);
        continue;
      }
      if (messages.length === 0) continue;
      const batch = this.processBatch(queueUrl, messages);
      this.inFlight.add(batch);
      await batch.finally(() => this.inFlight.delete(batch));
    }
  }

  // Grupos FIFO distintos em paralelo; dentro do grupo, em ordem.
  private async processBatch(queueUrl: string, messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.stopping) {
            await this.release(queueUrl, message);
            continue;
          }
          await this.processOne(queueUrl, message);
        }
      }),
    );
  }

  private async processOne(queueUrl: string, message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const outcome = await this.handler.handle(message.Body, receiveCount);
    try {
      if (outcome.action === 'ack') {
        await this.options.beforeAck?.(message, outcome);
        await this.delete(queueUrl, message);
      } else if (outcome.action === 'retry') {
        await this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: retryVisibilitySeconds(receiveCount),
          }),
        );
      } else {
        await this.deadLetter(queueUrl, message, outcome.reason);
      }
    } catch (error) {
      // Sem ack, a mensagem reaparece após o visibility timeout; a inbox evita efeito duplicado.
      this.logger.warn({ msg: 'could not settle message', messageId: message.MessageId, error: errorName(error) });
    }
  }

  private async deadLetter(queueUrl: string, message: Message, reason: string): Promise<void> {
    const dlqUrl = await this.urls.get(this.options.dlqName);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { reason: { DataType: 'String', StringValue: reason } },
      }),
    );
    await this.delete(queueUrl, message);
    this.metrics.increment(METRIC.dlqMessages, { reason });
    this.logger.warn({ msg: 'message moved to DLQ', messageId: message.MessageId, reason });
  }

  private delete(queueUrl: string, message: Message) {
    return this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private release(queueUrl: string, message: Message) {
    return this.client
      .send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }))
      .catch(() => undefined);
  }

  private async retryForever<T>(work: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await work();
      } catch (error) {
        if (this.abort.signal.aborted) throw error;
        this.logger.warn({ msg: 'sqs unavailable', error: errorName(error) });
        await sleep(1_000, this.abort.signal);
      }
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
