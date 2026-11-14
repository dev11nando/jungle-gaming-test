import { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { hostname } from 'node:os';
import { APP_CONFIG, type AppConfig } from '../../infra/config/app-config';
import {
  CLOCK,
  ID_GENERATOR,
  METRICS,
  UNIT_OF_WORK,
  type Clock,
  type IdGenerator,
  type Metrics,
  type UnitOfWork,
} from '../../domain/contracts';
import { nestLogger } from '../../infra/observability/nest-logger';
import { ProcessPendingReferences } from '../../domain/usecases/process-pending-references';
import { SubmitWagerTransaction } from '../../domain/usecases/submit-wager-transaction';
import { WageringModule } from './wagering.module';
import { HandleWagerMessage } from '../../domain/usecases/handle-wager-message';
import { OutboxPublisher } from '../../infra/messaging/outbox-publisher';
import { OutboxStore } from '../../infra/messaging/outbox-store';
import { PollingWorker } from '../../infra/messaging/polling-worker';
import { createSqsClient, QueueUrls } from '../../infra/messaging/sqs';
import { SqsWagerConsumer } from '../../infra/messaging/sqs-wager-consumer';

const WORKER_ID = Symbol('WORKER_ID');

@Module({
  imports: [WageringModule],
  providers: [
    { provide: WORKER_ID, useFactory: () => process.env.INSTANCE_ID ?? `${hostname()}:${process.pid}` },
    { provide: SQSClient, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createSqsClient(c.sqs) },
    { provide: QueueUrls, inject: [SQSClient], useFactory: (client: SQSClient) => new QueueUrls(client) },
    {
      provide: SqsWagerConsumer,
      inject: [APP_CONFIG, SQSClient, QueueUrls, UNIT_OF_WORK, SubmitWagerTransaction, METRICS],
      useFactory: (c: AppConfig, client: SQSClient, urls: QueueUrls, uow: UnitOfWork, submit: SubmitWagerTransaction, metrics: Metrics) =>
        new SqsWagerConsumer(client, urls, new HandleWagerMessage(uow, submit, metrics, nestLogger(HandleWagerMessage.name), c.sqs.maxReceiveCount), metrics, {
          queueName: c.sqs.queueName,
          dlqName: c.sqs.dlqName,
          visibilityTimeoutSeconds: c.sqs.visibilityTimeoutSeconds,
          waitTimeSeconds: c.sqs.waitTimeSeconds,
          pollers: c.sqs.pollers,
        }),
    },
    {
      provide: OutboxPublisher,
      inject: [APP_CONFIG, MikroORM, SQSClient, QueueUrls, METRICS, WORKER_ID],
      useFactory: (c: AppConfig, orm: MikroORM, client: SQSClient, urls: QueueUrls, metrics: Metrics, workerId: string) =>
        new OutboxPublisher(new OutboxStore(orm), client, urls, metrics, { workerId, eventsQueueName: c.sqs.eventsQueueName }),
    },
    {
      provide: PollingWorker,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, METRICS],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock, metrics: Metrics) => {
        const job = new ProcessPendingReferences(uow, ids, clock, metrics, nestLogger(ProcessPendingReferences.name));
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
