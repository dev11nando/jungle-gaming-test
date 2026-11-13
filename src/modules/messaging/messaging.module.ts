import { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { hostname } from 'node:os';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { Metrics } from '../../shared/application/metrics';
import { Clock, IdGenerator, UnitOfWork } from '../wagering/application/ports';
import { ProcessPendingReferences } from '../wagering/application/process-pending-references';
import { SubmitWagerTransaction } from '../wagering/application/submit-wager-transaction';
import { WageringModule } from '../wagering/wagering.module';
import { WagerMessageHandler } from './application/wager-message-handler';
import { OutboxPublisher } from './infrastructure/outbox-publisher';
import { OutboxStore } from './infrastructure/outbox-store';
import { PollingWorker } from './infrastructure/polling-worker';
import { createSqsClient, QueueUrls } from './infrastructure/sqs';
import { SqsWagerConsumer } from './infrastructure/sqs-wager-consumer';

const WORKER_ID = Symbol('WORKER_ID');

@Module({
  imports: [WageringModule],
  providers: [
    { provide: WORKER_ID, useFactory: () => process.env.INSTANCE_ID ?? `${hostname()}:${process.pid}` },
    { provide: SQSClient, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createSqsClient(c.sqs) },
    { provide: QueueUrls, inject: [SQSClient], useFactory: (client: SQSClient) => new QueueUrls(client) },
    {
      provide: SqsWagerConsumer,
      inject: [APP_CONFIG, SQSClient, QueueUrls, UnitOfWork, SubmitWagerTransaction, Metrics],
      useFactory: (c: AppConfig, client: SQSClient, urls: QueueUrls, uow: UnitOfWork, submit: SubmitWagerTransaction, metrics: Metrics) =>
        new SqsWagerConsumer(client, urls, new WagerMessageHandler(uow, submit, metrics, c.sqs.maxReceiveCount), metrics, {
          queueName: c.sqs.queueName,
          dlqName: c.sqs.dlqName,
          visibilityTimeoutSeconds: c.sqs.visibilityTimeoutSeconds,
          waitTimeSeconds: c.sqs.waitTimeSeconds,
          pollers: c.sqs.pollers,
        }),
    },
    {
      provide: OutboxPublisher,
      inject: [APP_CONFIG, MikroORM, SQSClient, QueueUrls, Metrics, WORKER_ID],
      useFactory: (c: AppConfig, orm: MikroORM, client: SQSClient, urls: QueueUrls, metrics: Metrics, workerId: string) =>
        new OutboxPublisher(new OutboxStore(orm), client, urls, metrics, { workerId, eventsQueueName: c.sqs.eventsQueueName }),
    },
    {
      provide: PollingWorker,
      inject: [UnitOfWork, IdGenerator, Clock, Metrics],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock, metrics: Metrics) => {
        const job = new ProcessPendingReferences(uow, ids, clock, metrics);
        return new PollingWorker('PendingReferenceWorker', () => job.runOnce(), 250);
      },
    },
  ],
})
export class MessagingModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SqsWagerConsumer) private readonly consumer: SqsWagerConsumer,
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
    @Inject(PollingWorker) private readonly pending: PollingWorker,
    @Inject(SQSClient) private readonly sqs: SQSClient,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.workers.has('consumer')) this.consumer.start();
    if (this.config.workers.has('outbox')) this.publisher.start();
    if (this.config.workers.has('pending-reference')) this.pending.start();
  }

  // Antes de fechar o pool: termina o que está em voo e devolve a visibilidade do resto.
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.consumer.stop(), this.publisher.stop(), this.pending.stop()]);
    this.sqs.destroy();
  }
}
