import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { METRIC, type Metrics } from '../../../shared/application/metrics';
import type { ClaimedOutboxMessage, OutboxStore } from './outbox-store';
import { sleep, type QueueUrls } from './sqs';

const SQS_BATCH_LIMIT = 10;

export interface PublisherOptions {
  workerId: string;
  eventsQueueName: string;
  batchSize?: number;
  leaseSeconds?: number;
  idleDelayMs?: number;
  /** Ponto de injeção de falha para testes: crash depois de publicar e antes de marcar. */
  afterPublish?: (ids: string[]) => Promise<void> | void;
}

export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);
  private running = false;
  private loop?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(
    private readonly store: OutboxStore,
    private readonly client: SQSClient,
    private readonly urls: QueueUrls,
    private readonly metrics: Metrics,
    private readonly options: PublisherOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loop?.catch(() => undefined);
  }

  async publishOnce(): Promise<number> {
    const batchSize = this.options.batchSize ?? 100;
    const claimed = await this.store.claim(this.options.workerId, batchSize, this.options.leaseSeconds ?? 30);
    const chunks: ClaimedOutboxMessage[][] = [];
    for (let i = 0; i < claimed.length; i += SQS_BATCH_LIMIT) chunks.push(claimed.slice(i, i + SQS_BATCH_LIMIT));
    const published = await Promise.all(chunks.map((chunk) => this.send(chunk)));
    const succeeded = published.flat();
    if (succeeded.length > 0) {
      await this.options.afterPublish?.(succeeded);
      await this.store.markPublished(succeeded, this.options.workerId);
    }
    const backlog = await this.store.backlog();
    this.metrics.setGauge(METRIC.outboxPending, backlog.pending);
    this.metrics.setGauge(METRIC.outboxLag, backlog.oldestAgeSeconds);
    return claimed.length;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let published = 0;
      try {
        published = await this.publishOnce();
      } catch (error) {
        this.logger.warn({ msg: 'outbox cycle failed', error: error instanceof Error ? error.name : 'Error' });
      }
      if (published < (this.options.batchSize ?? 100)) {
        await sleep(this.options.idleDelayMs ?? 200, this.abort.signal);
      }
    }
  }

  private async send(claimed: ClaimedOutboxMessage[]): Promise<string[]> {
    const byId = new Map(claimed.map((c) => [c.message.id, c.message]));
    let succeeded: string[] = [];
    const failed: { id: string; error: string }[] = [];
    try {
      const queueUrl = await this.urls.get(this.options.eventsQueueName);
      const res = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: claimed.map(({ message }) => ({
            Id: message.id,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
              eventId: { DataType: 'String', StringValue: message.id },
            },
          })),
        }),
      );
      succeeded = (res.Successful ?? []).map((s) => s.Id ?? '').filter((id) => byId.has(id));
      for (const f of res.Failed ?? []) failed.push({ id: f.Id ?? '', error: f.Code ?? 'SendFailed' });
    } catch (error) {
      for (const id of byId.keys()) failed.push({ id, error: error instanceof Error ? error.name : 'SendFailed' });
    }

    if (succeeded.length > 0) {
      const now = Date.now();
      for (const id of succeeded) {
        const m = byId.get(id);
        if (m) this.metrics.observe(METRIC.outboxPublishDelay, (now - m.occurredAt.getTime()) / 1000);
      }
      this.metrics.increment(METRIC.outboxPublished, {}, succeeded.length);
    }
    for (const f of failed) {
      const m = byId.get(f.id);
      if (!m) continue;
      await this.store.markFailed(m, this.options.workerId, f.error, new Date());
      this.metrics.increment(METRIC.outboxFailures, { error: f.error });
    }
    return succeeded;
  }
}
