import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ClusterNode, freePort, startJwksServer } from '../support/cluster';
import { resetSchema, TEST_DATABASE_URL, testPool } from '../support/database';
import { createTestQueues, drain, queueDepth, sendWagerMessage, testSqsClient, waitFor, type TestQueues } from '../support/sqs';
import { assertAllWalletsReconcile, ledgerSnapshot } from '../support/wagering';

let orm: MikroORM;
let pool: Pool;
let sqs: SQSClient;
let queues: TestQueues;
let jwks: Awaited<ReturnType<typeof startJwksServer>>;
let token: string;
const nodes: ClusterNode[] = [];

beforeAll(async () => {
  orm = await resetSchema();
  pool = testPool();
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
  jwks = await startJwksServer();
  token = await jwks.token();
  for (let i = 0; i < 3; i += 1) {
    nodes.push(
      new ClusterNode({ id: `node-${i}`, port: await freePort(), databaseUrl: TEST_DATABASE_URL, jwksUri: jwks.url, queues }),
    );
  }
  await Promise.all(nodes.map((n) => n.start()));
}, 90_000);

afterAll(async () => {
  await Promise.all(nodes.map((n) => n.kill()));
  await assertAllWalletsReconcile(pool);
  jwks.stop();
  sqs.destroy();
  await pool.end();
  await orm.close(true);
});

const node = (i: number) => nodes[i % nodes.length] as ClusterNode;

async function http(i: number, method: string, path: string, body?: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = await fetch(`${node(i).baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any };
}

async function openWallet(amount: string) {
  const playerId = randomUUID();
  const res = await http(0, 'POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

function wager(walletId: string, playerId: string, externalTransactionId: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...extra,
  };
}

describe('três instâncias reais (processos separados)', () => {
  test('wallet quente: 20 apostas de 10 sobre 100, cada uma enviada 2× a instâncias diferentes', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const bodies = Array.from({ length: 20 }, (_, i) => wager(walletId, playerId, `hot-${walletId}-${i}`));
    const responses = await Promise.all(
      bodies.flatMap((b, i) => [
        http(i, 'POST', '/wagering/transactions', b, `provider-a:${b.externalTransactionId}`),
        http(i + 1, 'POST', '/wagering/transactions', b, `provider-a:${b.externalTransactionId}`),
      ]),
    );
    expect(responses.every((r) => r.status === 200 || r.status === 422)).toBe(true);

    const byTx = new Map<string, number>();
    for (const r of responses) byTx.set(r.body.transactionId, r.status);
    expect(byTx.size).toBe(20);
    expect([...byTx.values()].filter((s) => s === 200)).toHaveLength(10);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '0.00', ledger: '0.00', debits: 10 });
  }, 30_000);

  test('a mesma aposta 50× distribuída entre as 3 instâncias → um único débito', async () => {
    const { walletId, playerId } = await openWallet('1000.00');
    const body = wager(walletId, playerId, `same-${walletId}`, { money: { amount: '7.77', currency: 'BRL' } });
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => http(i, 'POST', '/wagering/transactions', body, `provider-a:${body.externalTransactionId}`)),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '992.23', debits: 1 });
  }, 30_000);

  test('SQS com duplicatas e referências fora de ordem; uma instância morre (SIGKILL) e volta', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => openWallet('1000.00')));
    const data = (w: { walletId: string; playerId: string }, ext: string, extra: Record<string, unknown> = {}) => ({
      ...wager(w.walletId, w.playerId, ext, { money: { amount: '5.00', currency: 'BRL' }, ...extra }),
      idempotencyKey: `provider-a:${ext}`,
    });

    // REFUNDs chegam antes das BETs que referenciam.
    for (const w of wallets) {
      for (let i = 0; i < 5; i += 1) {
        await sendWagerMessage(
          sqs,
          queues.queueUrl,
          data(w, `refund-${w.walletId}-${i}`, { kind: 'REFUND', referenceExternalTransactionId: `bet-${w.walletId}-${i}` }),
        );
      }
    }

    const sendBets = async (from: number, to: number) => {
      for (const w of wallets) {
        for (let i = from; i < to; i += 1) {
          const d = data(w, `bet-${w.walletId}-${i}`);
          const messageId = await sendWagerMessage(sqs, queues.queueUrl, d);
          await sendWagerMessage(sqs, queues.queueUrl, d, { messageId }); // redelivery
          await sendWagerMessage(sqs, queues.queueUrl, d); // mesma operação, outra mensagem
        }
      }
    };
    await sendBets(0, 10);
    await Bun.sleep(500);
    await node(1).kill();
    await sendBets(10, 20);
    await Bun.sleep(1_000);
    await node(1).start();

    const walletIds = wallets.map((w) => w.walletId);
    await waitFor(
      async () => {
        const { rows } = await pool.query(
          `select count(*) filter (where status in ('PROCESSED','REJECTED','FAILED'))::int as done,
                  count(*)::int as total
             from wager_transactions where wallet_id = any($1) and kind in ('BET','REFUND')`,
          [walletIds],
        );
        return rows[0].total === 4 * 25 && rows[0].done === rows[0].total && (await queueDepth(sqs, queues.queueUrl)) === 0;
      },
      90_000,
      500,
    );

    for (const w of wallets) {
      expect(await ledgerSnapshot(pool, w.walletId)).toMatchObject({ balance: '925.00', ledger: '925.00', debits: 20, credits: 6 });
    }
    const statuses = await pool.query(
      `select kind, status, count(*)::int as n from wager_transactions
        where wallet_id = any($1) and kind <> 'OPENING' group by kind, status order by kind`,
      [walletIds],
    );
    expect(statuses.rows).toEqual([
      { kind: 'BET', status: 'PROCESSED', n: 80 },
      { kind: 'REFUND', status: 'PROCESSED', n: 20 },
    ]);
    const inbox = await pool.query(
      `select count(*)::int as n from inbox_messages i join wager_transactions t on t.id = i.transaction_id where t.wallet_id = any($1)`,
      [walletIds],
    );
    expect(inbox.rows[0].n).toBe(4 * (5 + 20 * 2));
    expect(await drain(sqs, queues.dlqUrl)).toHaveLength(0);
  }, 120_000);

  test('reinício completo: outbox drenada, eventos publicados e reconciliação consistente em todas as wallets', async () => {
    await waitFor(
      async () => (await pool.query(`select count(*)::int as n from outbox_messages where published_at is null`)).rows[0].n === 0,
      60_000,
      500,
    );
    await Promise.all(nodes.map((n) => n.kill()));
    await node(2).start();

    const wallets = (await pool.query<{ id: string }>(`select id from wallets`)).rows.map((r) => r.id);
    for (const walletId of wallets) {
      const rec = await http(2, 'POST', `/wallets/${walletId}/reconciliation`);
      expect(rec.status).toBe(200);
      expect(rec.body.consistent).toBe(true);
    }

    const expected = (await pool.query<{ id: string }>(`select id from outbox_messages`)).rows.map((r) => r.id).sort();
    const published = new Set((await drain(sqs, queues.eventsUrl)).map((m) => JSON.parse(m.Body ?? '{}').eventId as string));
    expect([...published].sort()).toEqual(expected);
  }, 120_000);
});
