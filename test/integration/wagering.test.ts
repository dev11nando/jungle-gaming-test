import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ConflictError, NotFoundError } from '../../src/domain/errors/application-errors';
import { FailureCode, WagerTransactionStatus as S } from '../../src/domain/entities/wagering-types';
import { resetSchema, testPool } from '../support/database';
import {
  assertAllWalletsReconcile,
  brl,
  buildServices,
  command,
  FailingUnitOfWork,
  ledgerSnapshot,
  wagerBody,
  type Services,
} from '../support/wagering';

let orm: MikroORM;
let pool: Pool;
let svc: Services;
const ctx = { correlationId: 'test' };

beforeAll(async () => {
  orm = await resetSchema();
  pool = testPool();
  svc = buildServices(orm);
});

afterAll(async () => {
  await assertAllWalletsReconcile(pool);
  await pool.end();
  await orm.close(true);
});

async function wallet(initial = '100.00') {
  const playerId = randomUUID();
  const w = await svc.openWallet.execute({ playerId, initialBalance: brl(initial) }, ctx);
  return { walletId: w.id, playerId };
}

const outboxTypes = async (aggregateIds: string[]) =>
  (
    await pool.query<{ event_type: string }>(
      `select event_type from outbox_messages where aggregate_id = any($1) order by position`,
      [aggregateIds],
    )
  ).rows.map((r) => r.event_type);

describe('abrir wallet', () => {
  test('saldo inicial positivo: OPENING + crédito + eventos no mesmo commit', async () => {
    const { walletId } = await wallet('1000.00');
    const snap = await ledgerSnapshot(pool, walletId);
    expect(snap).toMatchObject({ balance: '1000.00', ledger: '1000.00', entries: 1, credits: 1 });
    const tx = await pool.query(`select kind, status, provider_id from wager_transactions where wallet_id = $1`, [walletId]);
    expect(tx.rows).toEqual([{ kind: 'OPENING', status: 'PROCESSED', provider_id: 'internal' }]);
    const w = await svc.queries.getWallet(walletId);
    expect(w.version).toBe(1);
  });

  test('saldo zero: versão 1, sem ledger', async () => {
    const { walletId } = await wallet('0.00');
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '0.00', entries: 0 });
  });

  test('wallet duplicada para player + moeda é conflito', async () => {
    const playerId = randomUUID();
    await svc.openWallet.execute({ playerId, initialBalance: brl('1.00') }, ctx);
    const second = svc.openWallet.execute({ playerId, initialBalance: brl('5.00') }, ctx);
    await expect(second).rejects.toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
    const count = await pool.query(`select count(*)::int as n from wallets where player_id = $1`, [playerId]);
    expect(count.rows[0].n).toBe(1);
  });
});

describe('BET e idempotência', () => {
  test('BET processada: saldo, ledger e eventos atômicos', async () => {
    const { walletId, playerId } = await wallet('1000.00');
    const result = await svc.submit.execute(command(wagerBody(walletId, playerId, { money: { amount: '25.00', currency: 'BRL' } })), ctx);
    expect(result.idempotentReplay).toBe(false);
    expect(result.transaction.status).toBe(S.Processed);
    expect(result.transaction.resultBalance?.amount).toBe('975.00');
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '975.00', ledger: '975.00', debits: 1 });
    expect(await outboxTypes([walletId, result.transaction.id])).toEqual([
      'WalletBalanceChanged',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
    ]);
  });

  test('replay devolve o resultado original, inclusive o saldo daquele momento', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const body = wagerBody(walletId, playerId, { money: { amount: '30.00', currency: 'BRL' } });
    const first = await svc.submit.execute(command(body), ctx);
    await svc.submit.execute(command(wagerBody(walletId, playerId)), ctx);
    const replay = await svc.submit.execute(command(body), ctx);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.transaction.resultBalance?.amount).toBe('70.00');
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '60.00', debits: 2 });
  });

  test('mesmo valor escrito de outra forma ("30" vs "30.00") é a mesma operação', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const body = wagerBody(walletId, playerId, { money: { amount: '30.00', currency: 'BRL' } });
    await svc.submit.execute(command(body), ctx);
    const replay = await svc.submit.execute(command({ ...body, money: { amount: '30', currency: 'BRL' } }), ctx);
    expect(replay.idempotentReplay).toBe(true);
  });

  test('mesma key com payload diferente → conflito, sem efeito', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const body = wagerBody(walletId, playerId);
    await svc.submit.execute(command(body), ctx);
    const divergent = svc.submit.execute(command({ ...body, money: { amount: '11.00', currency: 'BRL' } }), ctx);
    await expect(divergent).rejects.toBeInstanceOf(ConflictError);
    await expect(divergent).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '90.00', debits: 1 });
  });

  test('mesmo externalTransactionId com outra key → conflito', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const body = wagerBody(walletId, playerId);
    await svc.submit.execute(command(body), ctx);
    await expect(svc.submit.execute(command(body, 'another-key'), ctx)).rejects.toMatchObject({
      code: 'EXTERNAL_TRANSACTION_ID_REUSED',
    });
  });

  test('wallet inexistente → WALLET_NOT_FOUND, nada persistido', async () => {
    const missing = randomUUID();
    await expect(svc.submit.execute(command(wagerBody(missing, 'p')), ctx)).rejects.toBeInstanceOf(NotFoundError);
  });

  test('moeda divergente é rejeição persistida, sem ledger', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const r = await svc.submit.execute(command(wagerBody(walletId, playerId, { money: { amount: '1.00', currency: 'USD' } })), ctx);
    expect(r.transaction.status).toBe(S.Rejected);
    expect(r.transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '100.00', entries: 1 });
  });
});

describe('concorrência (paralelismo real no PostgreSQL)', () => {
  test('cenário obrigatório: saldo 100, duas apostas simultâneas de 80', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const a = wagerBody(walletId, playerId, { money: { amount: '80.00', currency: 'BRL' } });
    const b = wagerBody(walletId, playerId, { money: { amount: '80.00', currency: 'BRL' } });
    const results = await Promise.all([svc.submit.execute(command(a), ctx), svc.submit.execute(command(b), ctx)]);

    const statuses = results.map((r) => r.transaction.status).sort();
    expect(statuses).toEqual([S.Processed, S.Rejected]);
    const rejected = results.find((r) => r.transaction.status === S.Rejected);
    expect(rejected?.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '20.00', ledger: '20.00', debits: 1 });

    const retries = await Promise.all([
      svc.submit.execute(command(a), ctx),
      svc.submit.execute(command(b), ctx),
      svc.submit.execute(command(a), ctx),
      svc.submit.execute(command(b), ctx),
    ]);
    expect(retries.every((r) => r.idempotentReplay)).toBe(true);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '20.00', debits: 1 });
  });

  test('a mesma aposta enviada 50 vezes em paralelo → um único débito', async () => {
    const { walletId, playerId } = await wallet('1000.00');
    const body = wagerBody(walletId, playerId, { money: { amount: '7.77', currency: 'BRL' } });
    const results = await Promise.all(Array.from({ length: 50 }, () => svc.submit.execute(command(body), ctx)));

    const ids = new Set(results.map((r) => r.transaction.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.transaction.resultBalance?.amount === '992.23')).toBe(true);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '992.23', debits: 1 });
    const tx = await pool.query(`select count(*)::int as n from wager_transactions where idempotency_key = $1`, [
      `provider-a:${String(body.externalTransactionId)}`,
    ]);
    expect(tx.rows[0].n).toBe(1);
  });

  test('muitas apostas distintas disputando a mesma wallet: nunca negativa, saldo = ledger', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const bodies = Array.from({ length: 30 }, () => wagerBody(walletId, playerId, { money: { amount: '7.00', currency: 'BRL' } }));
    const results = await Promise.all(bodies.map((b) => svc.submit.execute(command(b), ctx)));
    const processed = results.filter((r) => r.transaction.status === S.Processed).length;
    expect(processed).toBe(14); // floor(100 / 7)
    expect(results.filter((r) => r.transaction.failureCode === FailureCode.InsufficientFunds)).toHaveLength(16);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '2.00', ledger: '2.00', debits: 14 });
  });

  test('wallets distintas em paralelo', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => wallet('50.00')));
    const work = wallets.flatMap((w) =>
      Array.from({ length: 5 }, () => svc.submit.execute(command(wagerBody(w.walletId, w.playerId)), ctx)),
    );
    const results = await Promise.all(work);
    expect(results.every((r) => r.transaction.status === S.Processed)).toBe(true);
    for (const w of wallets) {
      expect(await ledgerSnapshot(pool, w.walletId)).toMatchObject({ balance: '0.00', debits: 5 });
    }
  });

  test('não há lock global: wallet travada não bloqueia outra wallet', async () => {
    const hot = await wallet('100.00');
    const other = await wallet('100.00');
    const blocker = await pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select 1 from wallets where id = $1 for update', [hot.walletId]);

      const hotBet = svc.submit.execute(command(wagerBody(hot.walletId, hot.playerId)), ctx);
      const started = Date.now();
      const otherResult = await svc.submit.execute(command(wagerBody(other.walletId, other.playerId)), ctx);
      expect(otherResult.transaction.status).toBe(S.Processed);
      expect(Date.now() - started).toBeLessThan(2_000);

      let hotDone = false;
      void hotBet.then(() => (hotDone = true));
      await Bun.sleep(200);
      expect(hotDone).toBe(false); // esperando o lock da wallet quente

      await blocker.query('commit');
      expect((await hotBet).transaction.status).toBe(S.Processed);
    } finally {
      blocker.release();
    }
  });
});

describe('reversões', () => {
  test('REFUND de BET processada credita; segundo REFUND concorrente → ALREADY_REVERSED', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const bet = wagerBody(walletId, playerId, { money: { amount: '40.00', currency: 'BRL' } });
    await svc.submit.execute(command(bet), ctx);
    const refund = () =>
      wagerBody(walletId, playerId, {
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: bet.externalTransactionId,
      });
    const results = await Promise.all([svc.submit.execute(command(refund()), ctx), svc.submit.execute(command(refund()), ctx)]);
    expect(results.map((r) => r.transaction.status).sort()).toEqual([S.Processed, S.Rejected]);
    expect(results.find((r) => r.transaction.status === S.Rejected)?.transaction.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '100.00', credits: 2, debits: 1 });
  });

  test('REFUND e ROLLBACK da mesma BET: só uma reversão vale', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const bet = wagerBody(walletId, playerId, { money: { amount: '10.00', currency: 'BRL' } });
    await svc.submit.execute(command(bet), ctx);
    const ref = { money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId };
    await svc.submit.execute(command(wagerBody(walletId, playerId, { kind: 'REFUND', ...ref })), ctx);
    const rb = await svc.submit.execute(command(wagerBody(walletId, playerId, { kind: 'ROLLBACK', ...ref })), ctx);
    expect(rb.transaction.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '100.00' });
  });

  test('ROLLBACK de WIN que deixaria saldo negativo → REVERSAL_WOULD_GO_NEGATIVE, auditável', async () => {
    const { walletId, playerId } = await wallet('0.00');
    const win = wagerBody(walletId, playerId, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } });
    await svc.submit.execute(command(win), ctx);
    await svc.submit.execute(command(wagerBody(walletId, playerId, { money: { amount: '45.00', currency: 'BRL' } })), ctx);
    const rb = await svc.submit.execute(
      command(
        wagerBody(walletId, playerId, {
          kind: 'ROLLBACK',
          money: { amount: '50.00', currency: 'BRL' },
          referenceExternalTransactionId: win.externalTransactionId,
        }),
      ),
      ctx,
    );
    expect(rb.transaction.status).toBe(S.Rejected);
    expect(rb.transaction.failureCode).toBe(FailureCode.ReversalWouldGoNegative);
    const persisted = await svc.queries.getTransaction(rb.transaction.id);
    expect(persisted.failureCode).toBe(FailureCode.ReversalWouldGoNegative);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '5.00' });
  });

  test('REFUND antes da BET → PENDING_REFERENCE, sem ledger, evento de pendência', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const refund = wagerBody(walletId, playerId, {
      kind: 'REFUND',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-that-will-come-later',
    });
    const r = await svc.submit.execute(command(refund), ctx);
    expect(r.transaction.status).toBe(S.PendingReference);
    expect(await outboxTypes([r.transaction.id])).toEqual(['WagerTransactionPendingReference']);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '100.00', entries: 1 });
    const replay = await svc.submit.execute(command(refund), ctx);
    expect(replay).toMatchObject({ idempotentReplay: true });
    expect(replay.transaction.status).toBe(S.PendingReference);
  });

  test('LOSS registra sem mover saldo e publica WagerTransactionProcessed', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const bet = wagerBody(walletId, playerId);
    await svc.submit.execute(command(bet), ctx);
    const loss = await svc.submit.execute(
      command(wagerBody(walletId, playerId, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId })),
      ctx,
    );
    expect(loss.transaction.status).toBe(S.Processed);
    expect(await outboxTypes([loss.transaction.id])).toEqual(['WagerTransactionProcessed']);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '90.00', entries: 2 });
    expect((await svc.queries.getWallet(walletId)).version).toBe(2);
  });
});

describe('atomicidade', () => {
  test('falha ao gravar a outbox desfaz transação, saldo e ledger', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const failing = buildServices(
      orm,
      new FailingUnitOfWork(svc.uow, (repos) => ({
        ...repos,
        outbox: {
          enqueue: async () => {
            throw new Error('boom: outbox unavailable');
          },
        },
      })),
    );
    const body = wagerBody(walletId, playerId);
    await expect(failing.submit.execute(command(body), ctx)).rejects.toThrow('boom');
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '100.00', entries: 1 });
    const tx = await pool.query(`select count(*)::int as n from wager_transactions where external_transaction_id = $1`, [
      body.externalTransactionId,
    ]);
    expect(tx.rows[0].n).toBe(0);
    const ok = await svc.submit.execute(command(body), ctx);
    expect(ok.idempotentReplay).toBe(false);
    expect(await ledgerSnapshot(pool, walletId)).toMatchObject({ balance: '90.00' });
  });
});

describe('ledger e reconciliação', () => {
  test('paginação por cursor opaco e estável', async () => {
    const { walletId, playerId } = await wallet('100.00');
    for (let i = 0; i < 4; i += 1) await svc.submit.execute(command(wagerBody(walletId, playerId)), ctx);
    const p1 = await svc.queries.getLedger(walletId, undefined, 2);
    expect(p1.items.map((e) => e.walletVersion)).toEqual([1, 2]);
    expect(p1.nextCursor).toBeString();
    const p2 = await svc.queries.getLedger(walletId, p1.nextCursor, 2);
    expect(p2.items.map((e) => e.walletVersion)).toEqual([3, 4]);
    const p3 = await svc.queries.getLedger(walletId, p2.nextCursor, 2);
    expect(p3.items.map((e) => e.walletVersion)).toEqual([5]);
    expect(p3.nextCursor).toBeUndefined();
    await expect(svc.queries.getLedger(walletId, 'garbage!', 2)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  test('reconciliação consistente', async () => {
    const { walletId, playerId } = await wallet('100.00');
    await svc.submit.execute(command(wagerBody(walletId, playerId, { money: { amount: '25.00', currency: 'BRL' } })), ctx);
    const r = await svc.reconcile.execute(walletId, ctx);
    expect(r.consistent).toBe(true);
    expect(r.storedBalance.amount).toBe('75.00');
    expect(r.calculatedBalance.amount).toBe('75.00');
    expect(r.difference.amount).toBe('0.00');
    expect(r.checkedEntries).toBe(2);
  });

  test('divergência é sinalizada e contada, nunca corrigida', async () => {
    const { walletId } = await wallet('100.00');
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Simula corrupção fora da aplicação.
      await client.query('alter table wallets disable trigger wallets_match_ledger');
      await client.query(`update wallets set balance_amount = 150 where id = $1`, [walletId]);
      await client.query('alter table wallets enable trigger wallets_match_ledger');
      await client.query('commit');
    } finally {
      client.release();
    }
    const r = await svc.reconcile.execute(walletId, ctx);
    expect(r.consistent).toBe(false);
    expect(r.difference.amount).toBe('50.00');
    expect(svc.metrics.counter('wagering_reconciliation_divergences_total')).toBe(1);
    expect((await svc.queries.getWallet(walletId)).balance.amount).toBe('150.00');
    const fix = await pool.connect();
    try {
      await fix.query('begin');
      await fix.query('alter table wallets disable trigger wallets_match_ledger');
      await fix.query(`update wallets set balance_amount = 100 where id = $1`, [walletId]);
      await fix.query('alter table wallets enable trigger wallets_match_ledger');
      await fix.query('commit');
    } finally {
      fix.release();
    }
  });
});
