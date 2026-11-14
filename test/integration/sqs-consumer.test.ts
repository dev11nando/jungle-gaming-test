import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { HandleWagerMessage } from '../../src/domain/usecases/handle-wager-message';
import { QueueUrls } from '../../src/infra/messaging/sqs';
import { SqsWagerConsumer, type ConsumerOptions } from '../../src/infra/messaging/sqs-wager-consumer';
import { TransientInfrastructureError } from '../../src/domain/errors/application-errors';
import type { UnitOfWork } from '../../src/domain/contracts';
import { resetSchema, testPool } from '../support/database';
import { createTestQueues, drain, queueDepth, sendWagerMessage, testSqsClient, waitFor, type TestQueues } from '../support/sqs';
import { assertAllWalletsReconcile, brl, buildServices, FailingUnitOfWork, ledgerSnapshot, testLogger, wagerBody, type Services } from '../support/wagering';

let orm: MikroORM;
let pool: Pool;
let sqs: SQSClient;
let svc: Services;
const consumers: SqsWagerConsumer[] = [];

beforeAll(async () => {
  orm = await resetSchema();
  pool = testPool();
  sqs = testSqsClient();
  svc = buildServices(orm);
});

afterAll(async () => {
  await Promise.all(consumers.map((c) => c.stop()));
  await assertAllWalletsReconcile(pool);
  await pool.end();
  await orm.close(true);
  sqs.destroy();
});

function consumer(
  queues: TestQueues,
  opts: { uow?: UnitOfWork; maxAttempts?: number; options?: Partial<ConsumerOptions> } = {},
): SqsWagerConsumer {
  const services = opts.uow ? buildServices(orm, opts.uow) : svc;
  const handler = new HandleWagerMessage(services.uow, services.submit, services.metrics, testLogger, opts.maxAttempts ?? 5);
  const c = new SqsWagerConsumer(sqs, new QueueUrls(sqs), handler, services.metrics, {
    queueName: queues.queueName,
    dlqName: queues.dlqName,
    visibilityTimeoutSeconds: 2,
    waitTimeSeconds: 1,
    shutdownGraceMs: 10_000,
    ...opts.options,
  });
  consumers.push(c);
  return c;
}

async function wallet(initial = '100.00') {
  const playerId = randomUUID();
  const w = await svc.openWallet.execute({ playerId, initialBalance: brl(initial) }, { correlationId: 't' });
  return { walletId: w.id, playerId };
}

function messageData(walletId: string, playerId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const body = wagerBody(walletId, playerId, extra);
  return { ...body, idempotencyKey: `${String(body.providerId)}:${String(body.externalTransactionId)}` };
}

const txCount = async (externalId: unknown) =>
  (await pool.query(`select count(*)::int as n from wager_transactions where external_transaction_id = $1`, [externalId])).rows[0].n;

const inboxCount = async (transactionId: string) =>
  (await pool.query(`select count(*)::int as n from inbox_messages where transaction_id = $1`, [transactionId])).rows[0].n;

describe('consumidor SQS', () => {
  test('processa, grava inbox na mesma transação e só então dá ack', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet();
    const data = messageData(walletId, playerId);
    const messageId = await sendWagerMessage(sqs, q.queueUrl, data);
    consumer(q).start();

    await waitFor(async () => (await txCount(data.externalTransactionId)) === 1);
    await waitFor(async () => (await queueDepth(sqs, q.queueUrl)) === 0);
    const inbox = await pool.query(`select consumer_name, processed_at, transaction_id from inbox_messages where message_id = $1`, [messageId]);
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0].processed_at).not.toBeNull();
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '90.00', debits: 1 });
  });

  test('redelivery do mesmo messageId não duplica efeito', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet();
    const data = messageData(walletId, playerId);
    const messageId = `msg-${randomUUID()}`;
    for (let i = 0; i < 5; i += 1) await sendWagerMessage(sqs, q.queueUrl, data, { messageId });
    consumer(q).start();
    consumer(q).start();

    await waitFor(async () => (await queueDepth(sqs, q.queueUrl)) === 0);
    expect(await txCount(data.externalTransactionId)).toBe(1);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '90.00', debits: 1 });
  });

  test('mesma operação em outro messageId: um efeito, duas entregas registradas', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet();
    const data = messageData(walletId, playerId);
    await sendWagerMessage(sqs, q.queueUrl, data);
    await sendWagerMessage(sqs, q.queueUrl, data);
    consumer(q).start();

    await waitFor(async () => (await queueDepth(sqs, q.queueUrl)) === 0);
    const tx = await pool.query(`select id from wager_transactions where external_transaction_id = $1`, [data.externalTransactionId]);
    expect(tx.rows).toHaveLength(1);
    expect(await inboxCount(tx.rows[0].id)).toBe(2);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ debits: 1 });
  });

  test('rejeição de negócio é terminal: ack, sem DLQ', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet('5.00');
    const data = messageData(walletId, playerId);
    await sendWagerMessage(sqs, q.queueUrl, data);
    consumer(q).start();

    await waitFor(async () => (await txCount(data.externalTransactionId)) === 1);
    await waitFor(async () => (await queueDepth(sqs, q.queueUrl)) === 0);
    const tx = await pool.query(`select status, failure_code from wager_transactions where external_transaction_id = $1`, [
      data.externalTransactionId,
    ]);
    expect(tx.rows[0]).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await drain(sqs, q.dlqUrl)).toHaveLength(0);
  });

  test('erros permanentes vão direto para a DLQ com o motivo', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet();
    await sendWagerMessage(sqs, q.queueUrl, {}, { raw: 'not json', groupId: 'g1' });
    await sendWagerMessage(sqs, q.queueUrl, messageData(walletId, playerId, { money: { amount: '1e3', currency: 'BRL' } }));
    await sendWagerMessage(sqs, q.queueUrl, messageData(walletId, playerId, { kind: 'OPENING' }));
    await sendWagerMessage(sqs, q.queueUrl, messageData(randomUUID(), playerId));
    consumer(q).start();

    const dead = await waitFor(async () => {
      const got = await drain(sqs, q.dlqUrl);
      return got.length > 0 ? got : undefined;
    });
    const all = [...dead];
    while (all.length < 4) all.push(...(await drain(sqs, q.dlqUrl)));
    const reasons = all.map((m) => m.MessageAttributes?.reason?.StringValue).sort();
    expect(reasons).toEqual(['INVALID_JSON', 'INVALID_MONEY', 'OPENING_NOT_SUBMITTABLE', 'WALLET_NOT_FOUND']);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '100.00', entries: 1 });
  });

  test('messageId reaproveitado com outro payload vai para a DLQ', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet();
    const messageId = `msg-${randomUUID()}`;
    const c = consumer(q);
    c.start();
    const first = messageData(walletId, playerId);
    await sendWagerMessage(sqs, q.queueUrl, first, { messageId });
    await waitFor(async () => (await txCount(first.externalTransactionId)) === 1);
    await sendWagerMessage(sqs, q.queueUrl, messageData(walletId, playerId), { messageId });
    const dead = await waitFor(async () => {
      const got = await drain(sqs, q.dlqUrl);
      return got.length > 0 ? got : undefined;
    });
    expect(dead[0]?.MessageAttributes?.reason?.StringValue).toBe('MESSAGE_ID_CONFLICT');
  });

  test('falha transitória: volta com backoff e é aplicada uma vez', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet();
    let failures = 0;
    const flaky = new FailingUnitOfWork(svc.uow, (repos) => {
      if (failures < 2) {
        failures += 1;
        throw new TransientInfrastructureError('db down', 'connection');
      }
      return repos;
    });
    const data = messageData(walletId, playerId);
    await sendWagerMessage(sqs, q.queueUrl, data);
    consumer(q, { uow: flaky }).start();

    await waitFor(async () => (await txCount(data.externalTransactionId)) === 1, 30_000);
    await waitFor(async () => (await queueDepth(sqs, q.queueUrl)) === 0);
    expect(failures).toBe(2);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ debits: 1 });
  }, 40_000);

  test('excedido o limite de tentativas: DLQ com MAX_ATTEMPTS_EXCEEDED', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet();
    const down = new FailingUnitOfWork(svc.uow, () => {
      throw new TransientInfrastructureError('db down', 'connection');
    });
    await sendWagerMessage(sqs, q.queueUrl, messageData(walletId, playerId));
    consumer(q, { uow: down, maxAttempts: 2 }).start();

    const dead = await waitFor(async () => {
      const got = await drain(sqs, q.dlqUrl);
      return got.length > 0 ? got : undefined;
    }, 30_000);
    expect(dead[0]?.MessageAttributes?.reason?.StringValue).toBe('MAX_ATTEMPTS_EXCEEDED');
  }, 40_000);

  test('processo morre depois do commit e antes do ack: outra instância reprocessa sem duplicar', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet();
    const data = messageData(walletId, playerId);
    await sendWagerMessage(sqs, q.queueUrl, data);

    const dying = consumer(q, {
      options: {
        beforeAck: () => {
          throw new Error('process killed before ack');
        },
      },
    });
    dying.start();
    await waitFor(async () => (await txCount(data.externalTransactionId)) === 1);
    await dying.stop();
    expect(await queueDepth(sqs, q.queueUrl)).toBe(1);

    consumer(q).start();
    await waitFor(async () => (await queueDepth(sqs, q.queueUrl)) === 0, 15_000);
    expect(await txCount(data.externalTransactionId)).toBe(1);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '90.00', debits: 1 });
  });

  test('SIGTERM: termina o que está em voo e devolve o resto; nada se perde nem duplica', async () => {
    const q = await createTestQueues(sqs);
    const { walletId, playerId } = await wallet('1000.00');
    const slow = new FailingUnitOfWork(svc.uow, (repos) => repos);
    const originalTx = slow.transaction.bind(slow);
    slow.transaction = async (work) => {
      await Bun.sleep(150);
      return originalTx(work);
    };
    const datas = Array.from({ length: 8 }, () => messageData(walletId, playerId));
    for (const d of datas) await sendWagerMessage(sqs, q.queueUrl, d, { groupId: walletId });

    const first = consumer(q, { uow: slow });
    first.start();
    await waitFor(async () => {
      const r = await pool.query(`select count(*)::int as n from wager_transactions where wallet_id = $1 and kind = 'BET'`, [walletId]);
      return r.rows[0].n >= 1;
    });
    await first.stop();
    const doneBySigterm = (
      await pool.query(`select count(*)::int as n from wager_transactions where wallet_id = $1 and kind = 'BET'`, [walletId])
    ).rows[0].n;
    expect(doneBySigterm).toBeGreaterThanOrEqual(1);

    consumer(q).start();
    await waitFor(async () => (await queueDepth(sqs, q.queueUrl)) === 0, 20_000);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '920.00', debits: 8 });
  }, 30_000);

  test('três consumidores concorrentes em várias wallets: saldo = ledger', async () => {
    const q = await createTestQueues(sqs);
    const wallets = await Promise.all([wallet('50.00'), wallet('50.00'), wallet('50.00')]);
    const sends: Promise<string>[] = [];
    for (const w of wallets) {
      for (let i = 0; i < 8; i += 1) sends.push(sendWagerMessage(sqs, q.queueUrl, messageData(w.walletId, w.playerId)));
    }
    await Promise.all(sends);
    for (let i = 0; i < 3; i += 1) consumer(q).start();

    await waitFor(async () => (await queueDepth(sqs, q.queueUrl)) === 0, 20_000);
    for (const w of wallets) {
      const snap = await ledgerSnapshot(pool, w.walletId);
      expect(snap.balance).toBe('0.00');
      expect(snap.debits).toBe(5);
    }
  }, 30_000);
});
