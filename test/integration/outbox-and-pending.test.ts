import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { OutboxPublisher, type PublisherOptions } from '../../src/modules/messaging/infrastructure/outbox-publisher';
import { OutboxStore } from '../../src/modules/messaging/infrastructure/outbox-store';
import { QueueUrls } from '../../src/modules/messaging/infrastructure/sqs';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system/system';
import { ProcessPendingReferences } from '../../src/modules/wagering/application/process-pending-references';
import { FailureCode, WagerTransactionStatus as S } from '../../src/modules/wagering/domain/wagering-types';
import { resetSchema, testPool } from '../support/database';
import { createTestQueues, drain, testSqsClient, waitFor } from '../support/sqs';
import { assertAllWalletsReconcile, brl, buildServices, command, ledgerSnapshot, wagerBody, type Services } from '../support/wagering';

let orm: MikroORM;
let pool: Pool;
let sqs: SQSClient;
let svc: Services;
const ctx = { correlationId: 't' };

beforeAll(async () => {
  orm = await resetSchema();
  pool = testPool();
  sqs = testSqsClient();
  svc = buildServices(orm);
});

afterAll(async () => {
  await assertAllWalletsReconcile(pool);
  await pool.end();
  await orm.close(true);
  sqs.destroy();
});

async function wallet(initial = '100.00') {
  const playerId = randomUUID();
  const w = await svc.openWallet.execute({ playerId, initialBalance: brl(initial) }, ctx);
  return { walletId: w.id, playerId };
}

function publisher(eventsQueueName: string, opts: Partial<PublisherOptions> = {}, client: SQSClient = sqs) {
  return new OutboxPublisher(new OutboxStore(orm), client, new QueueUrls(client), svc.metrics, {
    workerId: `pub-${randomUUID().slice(0, 6)}`,
    eventsQueueName,
    leaseSeconds: 1,
    ...opts,
  });
}

const pendingOutbox = async () =>
  (await pool.query(`select count(*)::int as n from outbox_messages where published_at is null`)).rows[0].n as number;

async function drainAll(drainPublishers: OutboxPublisher[]) {
  for (let i = 0; i < 50 && (await pendingOutbox()) > 0; i += 1) {
    await Promise.all(drainPublishers.map((p) => p.publishOnce()));
  }
}

describe('outbox publisher', () => {
  test('publica envelopes confirmados e marca published_at', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet();
    const bet = await svc.submit.execute(command(wagerBody(walletId, playerId)), ctx);
    const p = publisher(q.eventsQueueName);
    await drainAll([p]);

    const received = await drain(sqs, q.eventsUrl);
    const bodies = received.map((m) => JSON.parse(m.Body ?? '{}'));
    const types = bodies.map((b) => b.eventType).sort();
    // Abertura (crédito + OPENING processada) e aposta (débito + BET processada).
    expect(types).toEqual(['WagerTransactionProcessed', 'WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged']);
    const processed = bodies.find((b) => b.eventType === 'WagerTransactionProcessed' && b.data.kind === 'BET');
    expect(processed).toMatchObject({ aggregateId: bet.transaction.id, version: 1, data: { status: 'PROCESSED' } });
    expect(received.every((m) => m.MessageAttributes?.eventId?.StringValue === JSON.parse(m.Body ?? '{}').eventId)).toBe(true);
    expect(await pendingOutbox()).toBe(0);
  });

  test('dois publishers concorrentes: todo evento publicado, nenhum perdido', async () => {
    const q = await createTestQueues(sqs);
    const wallets = await Promise.all(Array.from({ length: 5 }, () => wallet('100.00')));
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 4 }, () => svc.submit.execute(command(wagerBody(w.walletId, w.playerId)), ctx))),
    );
    const expected = (await pool.query(`select id from outbox_messages where published_at is null`)).rows.map((r) => r.id).sort();
    expect(expected.length).toBe(5 * 2 + 20 * 2);

    await drainAll([publisher(q.eventsQueueName), publisher(q.eventsQueueName)]);
    const received = (await drain(sqs, q.eventsUrl)).map((m) => JSON.parse(m.Body ?? '{}').eventId as string);
    expect([...new Set(received)].sort()).toEqual(expected);
    expect(await pendingOutbox()).toBe(0);
  });

  test('commit confirmado, publisher morre antes de marcar: outra instância assume e publica', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet();
    await svc.submit.execute(command(wagerBody(walletId, playerId)), ctx);
    const ids = (await pool.query(`select id from outbox_messages where published_at is null`)).rows.map((r) => r.id).sort();

    const dying = publisher(q.eventsQueueName, {
      afterPublish: () => {
        throw new Error('killed after publish');
      },
    });
    await expect(dying.publishOnce()).rejects.toThrow('killed');
    expect(await pendingOutbox()).toBe(ids.length);

    const survivor = publisher(q.eventsQueueName);
    expect(await survivor.publishOnce()).toBe(0); // lease ainda vale
    await Bun.sleep(1_100);
    await drainAll([survivor]);
    expect(await pendingOutbox()).toBe(0);

    const received = (await drain(sqs, q.eventsUrl)).map((m) => JSON.parse(m.Body ?? '{}').eventId as string);
    expect([...new Set(received)].sort()).toEqual(ids);
  });

  test('SQS recusando: tentativa registrada com backoff e publicação posterior', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet();
    await svc.submit.execute(command(wagerBody(walletId, playerId)), ctx);
    const broken = { send: async () => Promise.reject(new Error('sqs down')) } as unknown as SQSClient;
    await publisher(q.eventsQueueName, {}, broken).publishOnce();

    const rows = await pool.query(
      `select attempts, last_error, locked_by, next_attempt_at > now() as delayed from outbox_messages where published_at is null`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((r) => r.attempts === 1 && r.locked_by === null && r.delayed && r.last_error === 'Error')).toBe(true);

    await Bun.sleep(1_100);
    await drainAll([publisher(q.eventsQueueName)]);
    expect(await pendingOutbox()).toBe(0);
  });
});

describe('referência fora de ordem', () => {
  const ids = new UuidV7Generator();
  const clock = new SystemClock();

  test('REFUND antes da BET: fica pendente e é aplicado quando a BET chega', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const betBody = wagerBody(walletId, playerId, { money: { amount: '30.00', currency: 'BRL' } });
    const refund = await svc.submit.execute(
      command(
        wagerBody(walletId, playerId, {
          kind: 'REFUND',
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: betBody.externalTransactionId,
        }),
      ),
      ctx,
    );
    expect(refund.transaction.status).toBe(S.PendingReference);

    await svc.submit.execute(command(betBody), ctx);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '70.00' });

    const worker = new ProcessPendingReferences(svc.uow, ids, clock, svc.metrics);
    await waitFor(async () => (await worker.runOnce()) > 0, 5_000);
    const after = await svc.queries.getTransaction(refund.transaction.id);
    expect(after.status).toBe(S.Processed);
    expect(after.referenceTransactionId).toBeString();
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '100.00', credits: 2, debits: 1 });
  });

  test('referência nunca chega: REJECTED REFERENCE_NOT_FOUND com evento', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const rb = await svc.submit.execute(
      command(wagerBody(walletId, playerId, { kind: 'ROLLBACK', referenceExternalTransactionId: `ghost-${randomUUID()}` })),
      ctx,
    );
    const policy = { baseDelayMs: 1_000, maxDelayMs: 2_000, maxAttempts: 2, ttlMs: 60_000 };
    await pool.query(`update wager_transactions set next_reference_attempt_at = now() where id = $1`, [rb.transaction.id]);
    const worker = new ProcessPendingReferences(svc.uow, ids, clock, svc.metrics, policy);
    await worker.processOne(rb.transaction.id);
    expect((await svc.queries.getTransaction(rb.transaction.id)).status).toBe(S.PendingReference);
    await pool.query(`update wager_transactions set next_reference_attempt_at = now() where id = $1`, [rb.transaction.id]);
    await worker.processOne(rb.transaction.id);

    const final = await svc.queries.getTransaction(rb.transaction.id);
    expect(final.status).toBe(S.Rejected);
    expect(final.failureCode).toBe(FailureCode.ReferenceNotFound);
    const events = await pool.query(`select event_type from outbox_messages where aggregate_id = $1 order by position`, [
      rb.transaction.id,
    ]);
    expect(events.rows.map((r) => r.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '100.00', entries: 1 });
  });

  test('dois workers sobre a mesma pendência: um único efeito', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const betBody = wagerBody(walletId, playerId, { money: { amount: '10.00', currency: 'BRL' } });
    const refund = await svc.submit.execute(
      command(
        wagerBody(walletId, playerId, {
          kind: 'REFUND',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: betBody.externalTransactionId,
        }),
      ),
      ctx,
    );
    await svc.submit.execute(command(betBody), ctx);
    const a = new ProcessPendingReferences(svc.uow, ids, clock, svc.metrics);
    const b = new ProcessPendingReferences(svc.uow, ids, clock, svc.metrics);
    await Promise.all([a.processOne(refund.transaction.id), b.processOne(refund.transaction.id)]);
    expect((await svc.queries.getTransaction(refund.transaction.id)).status).toBe(S.Processed);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '100.00', credits: 2, debits: 1 });
  });
});
