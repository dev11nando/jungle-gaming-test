import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { LedgerEntryRecord, WalletRecord } from '../../src/infrastructure/database/records';
import { inTransaction, resetSchema, sqlState, testPool } from '../support/database';

let orm: MikroORM;
let pool: Pool;

beforeAll(async () => {
  orm = await resetSchema();
  pool = testPool();
});

afterAll(async () => {
  await pool.end();
  await orm.close(true);
});

const HASH = 'a'.repeat(64);
type Db = Pool | PoolClient;

async function insertWallet(db: Db, opts: { id?: string; player?: string; balance?: string; version?: number } = {}) {
  const id = opts.id ?? randomUUID();
  await db.query(
    `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     values ($1, $2, 'BRL', $3, $4, now(), now())`,
    [id, opts.player ?? randomUUID(), opts.balance ?? '0.00', opts.version ?? 1],
  );
  return id;
}

async function insertTx(
  db: Db,
  walletId: string,
  opts: Partial<{
    id: string;
    kind: string;
    amount: string;
    status: string;
    failureCode: string | null;
    reference: string | null;
    referenceId: string | null;
    provider: string;
    externalId: string;
    key: string;
  }> = {},
) {
  const id = opts.id ?? randomUUID();
  const kind = opts.kind ?? 'BET';
  const status = opts.status ?? 'PROCESSED';
  const provider = opts.provider ?? (kind === 'OPENING' ? 'internal' : 'provider-a');
  const externalId = opts.externalId ?? randomUUID();
  const terminal = ['PROCESSED', 'REJECTED', 'FAILED'].includes(status);
  await db.query(
    `insert into wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
       status, failure_code, result_balance_amount, result_wallet_version, next_reference_attempt_at,
       created_at, processed_at, completed_at)
     values ($1,$2,$3,$4,$5,$6,'p','r','g',$7,$8,'BRL',$9,$10,$11,$12,$13,$14,$15, now(), $16, $17)`,
    [
      id,
      provider,
      externalId,
      opts.key ?? `${provider}:${externalId}`,
      HASH,
      walletId,
      kind,
      opts.amount ?? '10.00',
      opts.reference ?? null,
      opts.referenceId ?? null,
      status,
      'failureCode' in opts ? opts.failureCode : status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null,
      status === 'PROCESSED' ? '0.00' : null,
      status === 'PROCESSED' ? 1 : null,
      status === 'PENDING_REFERENCE' ? new Date() : null,
      status === 'PROCESSED' ? new Date() : null,
      terminal ? new Date() : null,
    ],
  );
  return id;
}

async function insertEntry(
  db: Db,
  walletId: string,
  txId: string,
  e: { direction: string; amount: string; before: string; after: string; version: number },
) {
  const id = randomUUID();
  await db.query(
    `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
     values ($1,$2,$3,$4,$5,'BRL',$6,$7,$8, now())`,
    [id, walletId, txId, e.direction, e.amount, e.before, e.after, e.version],
  );
  return id;
}

async function openedWallet(balance = '100.00') {
  return inTransaction(pool, async (c) => {
    const walletId = await insertWallet(c, { balance });
    const txId = await insertTx(c, walletId, { kind: 'OPENING', amount: balance });
    await insertEntry(c, walletId, txId, { direction: 'CREDIT', amount: balance, before: '0.00', after: balance, version: 1 });
    return { walletId, openingTxId: txId };
  });
}

async function debit(walletId: string, amount: string, before: string, after: string, version: number) {
  return inTransaction(pool, async (c) => {
    const txId = await insertTx(c, walletId, { kind: 'BET', amount });
    await insertEntry(c, walletId, txId, { direction: 'DEBIT', amount, before, after, version });
    await c.query('update wallets set balance_amount = $2, version = $3 where id = $1', [walletId, after, version]);
    return txId;
  });
}

describe('migrations', () => {
  test('down até 0 remove o schema e up recria', async () => {
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    const gone = await pool.query(`select to_regclass('public.wallets') as t`);
    expect(gone.rows[0].t).toBeNull();
    await migrator.up();
    const back = await pool.query(`select to_regclass('public.wallet_ledger_entries') as t`);
    expect(back.rows[0].t).toBe('wallet_ledger_entries');
  });
});

describe('wallets', () => {
  test('no máximo uma wallet por player + currency', async () => {
    const player = randomUUID();
    await insertWallet(pool, { player });
    expect(await sqlState(insertWallet(pool, { player }))).toBe('23505');
  });

  test('saldo negativo é recusado pelo banco', async () => {
    expect(await sqlState(insertWallet(pool, { balance: '-0.01' }))).toBe('23514');
  });

  test('saldo positivo sem lançamento correspondente falha no commit', async () => {
    expect(await sqlState(inTransaction(pool, (c) => insertWallet(c, { balance: '10.00' })))).toBe('23514');
  });

  test('alterar saldo sem lançamento no ledger falha no commit', async () => {
    const { walletId } = await openedWallet();
    const state = await sqlState(
      inTransaction(pool, (c) => c.query(`update wallets set balance_amount = 999, version = 2 where id = $1`, [walletId])),
    );
    expect(state).toBe('23514');
    const row = await pool.query('select balance_amount, version from wallets where id = $1', [walletId]);
    expect(row.rows[0]).toEqual({ balance_amount: '100.00', version: 1 });
  });

  test('fluxo completo (OPENING + débito) é aceito e o saldo bate com o ledger', async () => {
    const { walletId } = await openedWallet('100.00');
    await debit(walletId, '80.00', '100.00', '20.00', 2);
    const r = await pool.query(
      `select w.balance_amount,
              (select sum(case direction when 'CREDIT' then amount else -amount end) from wallet_ledger_entries e where e.wallet_id = w.id) as ledger
         from wallets w where w.id = $1`,
      [walletId],
    );
    expect(r.rows[0]).toEqual({ balance_amount: '20.00', ledger: '20.00' });
  });

  test('wallet não pode ser excluída', async () => {
    const { walletId } = await openedWallet();
    expect(await sqlState(pool.query('delete from wallets where id = $1', [walletId]))).not.toBeUndefined();
  });
});

describe('ledger', () => {
  test('é append-only: UPDATE, DELETE e TRUNCATE são recusados', async () => {
    const { walletId } = await openedWallet();
    expect(await sqlState(pool.query(`update wallet_ledger_entries set amount = 1 where wallet_id = $1`, [walletId]))).toBe('P0001');
    expect(await sqlState(pool.query(`delete from wallet_ledger_entries where wallet_id = $1`, [walletId]))).toBe('P0001');
    expect(await sqlState(pool.query(`truncate wallet_ledger_entries cascade`))).toBe('P0001');
  });

  test('aritmética do lançamento é verificada', async () => {
    const { walletId } = await openedWallet();
    const state = await sqlState(
      inTransaction(pool, async (c) => {
        const tx = await insertTx(c, walletId, { amount: '10.00' });
        await insertEntry(c, walletId, tx, { direction: 'DEBIT', amount: '10.00', before: '100.00', after: '91.00', version: 2 });
      }),
    );
    expect(state).toBe('23514');
  });

  test('encadeamento: balance_before precisa ser o balance_after anterior', async () => {
    const { walletId } = await openedWallet();
    const state = await sqlState(
      inTransaction(pool, async (c) => {
        const tx = await insertTx(c, walletId, { amount: '10.00' });
        await insertEntry(c, walletId, tx, { direction: 'DEBIT', amount: '10.00', before: '50.00', after: '40.00', version: 2 });
      }),
    );
    expect(state).toBe('23514');
  });

  test('uma versão da wallet tem um único lançamento (sem bifurcação)', async () => {
    const { walletId } = await openedWallet();
    await debit(walletId, '10.00', '100.00', '90.00', 2);
    expect(await sqlState(debit(walletId, '10.00', '100.00', '90.00', 2))).toBe('23505');
  });

  test('no máximo um lançamento por transação', async () => {
    const { walletId, openingTxId } = await openedWallet();
    const state = await sqlState(
      insertEntry(pool, walletId, openingTxId, { direction: 'CREDIT', amount: '100.00', before: '100.00', after: '200.00', version: 2 }),
    );
    expect(state).toBe('23505');
  });

  test('valor do lançamento precisa ser o valor da transação', async () => {
    const { walletId } = await openedWallet();
    const state = await sqlState(
      inTransaction(pool, async (c) => {
        const tx = await insertTx(c, walletId, { amount: '10.00' });
        await insertEntry(c, walletId, tx, { direction: 'DEBIT', amount: '20.00', before: '100.00', after: '80.00', version: 2 });
        await c.query('update wallets set balance_amount = 80, version = 2 where id = $1', [walletId]);
      }),
    );
    expect(state).toBe('23503');
  });

  test('numeric é exato e volta como string pelo MikroORM', async () => {
    const { walletId } = await openedWallet('0.30');
    const em = orm.em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { id: walletId });
    const entries = await em.find(LedgerEntryRecord, { walletId });
    expect(wallet.balanceAmount).toBe('0.30');
    expect(typeof wallet.balanceAmount).toBe('string');
    expect(entries[0]?.balanceAfter).toBe('0.30');
  });
});

describe('wager_transactions', () => {
  test('idempotency_key única', async () => {
    const { walletId } = await openedWallet();
    await insertTx(pool, walletId, { key: 'k-1' });
    expect(await sqlState(insertTx(pool, walletId, { key: 'k-1' }))).toBe('23505');
  });

  test('(provider_id, external_transaction_id) único', async () => {
    const { walletId } = await openedWallet();
    await insertTx(pool, walletId, { externalId: 'ext-1', key: 'a' });
    expect(await sqlState(insertTx(pool, walletId, { externalId: 'ext-1', key: 'b' }))).toBe('23505');
  });

  test('REFUND e ROLLBACK exigem referência', async () => {
    const { walletId } = await openedWallet();
    expect(await sqlState(insertTx(pool, walletId, { kind: 'REFUND', status: 'PENDING' }))).toBe('23514');
    expect(await sqlState(insertTx(pool, walletId, { kind: 'ROLLBACK', status: 'PENDING' }))).toBe('23514');
  });

  test('OPENING só no escopo interno', async () => {
    const { walletId } = await openedWallet();
    expect(await sqlState(insertTx(pool, walletId, { kind: 'OPENING', provider: 'provider-a' }))).toBe('23514');
    expect(await sqlState(insertTx(pool, walletId, { kind: 'BET', provider: 'internal' }))).toBe('23514');
  });

  test('uma única reversão PROCESSED por referência; rejeitada não consome a vaga', async () => {
    const { walletId } = await openedWallet();
    const betId = await insertTx(pool, walletId, { externalId: 'bet-r' });
    await insertTx(pool, walletId, {
      kind: 'REFUND',
      reference: 'bet-r',
      referenceId: betId,
      status: 'REJECTED',
      failureCode: 'AMOUNT_MISMATCH',
    });
    await insertTx(pool, walletId, { kind: 'REFUND', reference: 'bet-r', referenceId: betId });
    expect(await sqlState(insertTx(pool, walletId, { kind: 'REFUND', reference: 'bet-r', referenceId: betId }))).toBe('23505');
    expect(await sqlState(insertTx(pool, walletId, { kind: 'ROLLBACK', reference: 'bet-r', referenceId: betId }))).toBe('23505');
  });

  test('estado terminal é imutável e não há DELETE', async () => {
    const { walletId } = await openedWallet();
    const id = await insertTx(pool, walletId, { status: 'REJECTED' });
    expect(
      await sqlState(pool.query(`update wager_transactions set status = 'PROCESSED', failure_code = null where id = $1`, [id])),
    ).toBe('P0001');
    expect(await sqlState(pool.query(`delete from wager_transactions where id = $1`, [id]))).toBe('P0001');
  });

  test('campos de negócio não mudam nem em transação pendente', async () => {
    const { walletId } = await openedWallet();
    const id = await insertTx(pool, walletId, { status: 'PENDING' });
    expect(await sqlState(pool.query(`update wager_transactions set amount = 1 where id = $1`, [id]))).toBe('P0001');
  });

  test('status e failure code consistentes', async () => {
    const { walletId } = await openedWallet();
    expect(await sqlState(insertTx(pool, walletId, { status: 'REJECTED', failureCode: null }))).toBe('23514');
  });
});

describe('inbox e outbox', () => {
  test('inbox única por (consumer_name, message_id)', async () => {
    const insert = () =>
      pool.query(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('c', 'm-1', $1, now())`,
        [HASH],
      );
    await insert();
    expect(await sqlState(insert())).toBe('23505');
  });

  test('outbox: payload precisa carregar o mesmo eventId/eventType e é imutável', async () => {
    const id = randomUUID();
    const insert = (payloadId: string) =>
      pool.query(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
         values ($1, 'agg', 'X', $2, now(), now())`,
        [id, JSON.stringify({ eventId: payloadId, eventType: 'X' })],
      );
    expect(await sqlState(insert(randomUUID()))).toBe('23514');
    await insert(id);
    expect(await sqlState(pool.query(`update outbox_messages set event_type = 'Y' where id = $1`, [id]))).not.toBeUndefined();
    await pool.query(`update outbox_messages set published_at = now() where id = $1`, [id]);
    expect(await sqlState(pool.query(`update outbox_messages set published_at = null where id = $1`, [id]))).toBe('P0001');
  });
});
