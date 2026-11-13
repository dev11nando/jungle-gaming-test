import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { TransientInfrastructureError } from '../../src/modules/wagering/application/errors';
import { UnitOfWork } from '../../src/modules/wagering/application/ports';
import { resetSchema } from '../support/database';
import { startHttpApp, type TestHttpApp } from '../support/http-app';

let orm: MikroORM;
let http: TestHttpApp;
let tokenA: string;

beforeAll(async () => {
  orm = await resetSchema();
  http = await startHttpApp();
  tokenA = await http.token();
});

afterAll(async () => {
  await http.close();
  await orm.close(true);
});

async function call(method: string, path: string, opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  const token = opts.token === undefined ? tokenA : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${http.baseUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function createWallet(amount = '1000.00') {
  const playerId = randomUUID();
  const res = await call('POST', '/wallets', { body: { playerId, initialBalance: { amount, currency: 'BRL' } } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

let seq = 0;
function bet(walletId: string, playerId: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  return {
    providerId: 'provider-a',
    externalTransactionId: `http-${Date.now()}-${seq}`,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...extra,
  };
}

const submit = (body: Record<string, unknown>, opts: { key?: string | null; token?: string } = {}) =>
  call('POST', '/wagering/transactions', {
    body,
    token: opts.token,
    headers: opts.key === null ? {} : { 'idempotency-key': opts.key ?? `${String(body.providerId)}:${String(body.externalTransactionId)}` },
  });

describe('públicos e autenticação', () => {
  test('health live e metrics não pedem token', async () => {
    expect((await call('GET', '/health/live', { token: null })).status).toBe(200);
    const metrics = await call('GET', '/metrics', { token: null });
    expect(metrics.status).toBe(200);
  });

  test('sem token → 401; audience errada → 401; sem provider_id → 403', async () => {
    expect((await call('GET', '/wallets/' + randomUUID(), { token: null })).status).toBe(401);
    expect((await call('GET', '/wallets/' + randomUUID(), { token: await http.token(undefined, { audience: 'x' }) })).status).toBe(401);
    expect((await call('GET', '/wallets/' + randomUUID(), { token: await http.token({}) })).status).toBe(403);
  });

  test('X-Correlation-Id é propagado', async () => {
    const res = await call('GET', '/health/live', { token: null, headers: { 'x-correlation-id': 'corr-123' } });
    expect(res.headers.get('x-correlation-id')).toBe('corr-123');
  });
});

describe('wallets', () => {
  test('POST /wallets → 201 com contrato do enunciado', async () => {
    const playerId = randomUUID();
    const res = await call('POST', '/wallets', { body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const dup = await call('POST', '/wallets', { body: { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test.each([
    [{ amount: '1e3', currency: 'BRL' }],
    [{ amount: '-1.00', currency: 'BRL' }],
    [{ amount: '1.001', currency: 'BRL' }],
    [{ amount: 10, currency: 'BRL' }],
    [{ amount: '10.00', currency: 'brl' }],
  ])('saldo inicial inválido %p → 400 INVALID_MONEY', async (initialBalance) => {
    const res = await call('POST', '/wallets', { body: { playerId: randomUUID(), initialBalance } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MONEY');
  });

  test('JSON malformado → 400', async () => {
    expect((await call('POST', '/wallets', { body: '{"playerId":' })).status).toBe(400);
  });

  test('GET wallet, ledger paginado e reconciliação', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    for (let i = 0; i < 3; i += 1) expect((await submit(bet(walletId, playerId))).status).toBe(200);

    const w = await call('GET', `/wallets/${walletId}`);
    expect(w.body).toMatchObject({ balance: { amount: '25.00', currency: 'BRL' }, version: 4 });

    const p1 = await call('GET', `/wallets/${walletId}/ledger?limit=2`);
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.items[0]).toMatchObject({ direction: 'CREDIT', money: { amount: '100.00', currency: 'BRL' }, walletVersion: 1 });
    const p2 = await call('GET', `/wallets/${walletId}/ledger?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((i: { walletVersion: number }) => i.walletVersion)).toEqual([3, 4]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await call('GET', `/wallets/${walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await call('GET', `/wallets/${walletId}/ledger?cursor=xx`)).status).toBe(400);

    const rec = await call('POST', `/wallets/${walletId}/reconciliation`);
    expect(rec.status).toBe(200);
    expect(rec.body).toEqual({
      walletId,
      storedBalance: { amount: '25.00', currency: 'BRL' },
      calculatedBalance: { amount: '25.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 4,
    });
  });

  test('wallet inexistente → 404; id malformado → 400', async () => {
    expect((await call('GET', `/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await call('GET', `/wallets/not-a-uuid`)).status).toBe(400);
  });
});

describe('POST /wagering/transactions — mapa de status', () => {
  test('200 PROCESSED, depois 200 replay com o saldo original', async () => {
    const { walletId, playerId } = await createWallet('1000.00');
    const body = bet(walletId, playerId);
    const first = await submit(body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    await submit(bet(walletId, playerId));
    const replay = await submit(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('400 sem Idempotency-Key, kind OPENING, REFUND sem referência, campo faltando', async () => {
    const { walletId, playerId } = await createWallet();
    const missingKey = await submit(bet(walletId, playerId), { key: null });
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await submit(bet(walletId, playerId, { kind: 'OPENING' }))).body.error.code).toBe('OPENING_NOT_SUBMITTABLE');
    expect((await submit(bet(walletId, playerId, { kind: 'REFUND' }))).body.error.code).toBe('REFERENCE_REQUIRED');
    expect((await submit(bet(walletId, playerId, { roundId: undefined }))).status).toBe(400);
    expect((await submit(bet(walletId, playerId, { money: { amount: 25, currency: 'BRL' } }))).status).toBe(400);
  });

  test('403 quando o provedor do token difere do corpo', async () => {
    const { walletId, playerId } = await createWallet();
    const res = await submit(bet(walletId, playerId, { providerId: 'provider-b' }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROVIDER_MISMATCH');
  });

  test('404 wallet inexistente', async () => {
    const res = await submit(bet(randomUUID(), 'p'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('409 mesma key com payload divergente', async () => {
    const { walletId, playerId } = await createWallet();
    const body = bet(walletId, playerId);
    await submit(body);
    const res = await submit({ ...body, money: { amount: '26.00', currency: 'BRL' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('422 rejeição de negócio persistida, e replay repete o 422', async () => {
    const { walletId, playerId } = await createWallet('10.00');
    const body = bet(walletId, playerId);
    const res = await submit(body);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const replay = await submit(body);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test('202 aceite pendente (referência ainda não chegou)', async () => {
    const { walletId, playerId } = await createWallet();
    const res = await submit(bet(walletId, playerId, { kind: 'ROLLBACK', referenceExternalTransactionId: 'not-yet' }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  test('2 apostas simultâneas de 80 sobre 100 via HTTP: 200 + 422, saldo 20', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const [a, b] = await Promise.all([
      submit(bet(walletId, playerId, { money: { amount: '80.00', currency: 'BRL' } })),
      submit(bet(walletId, playerId, { money: { amount: '80.00', currency: 'BRL' } })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    const w = await call('GET', `/wallets/${walletId}`);
    expect(w.body.balance.amount).toBe('20.00');
  });
});

describe('consultas de transação', () => {
  test('por id interno e por id do provedor; outro provedor não enxerga', async () => {
    const { walletId, playerId } = await createWallet();
    const body = bet(walletId, playerId);
    const created = await submit(body);
    const byId = await call('GET', `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: created.body.transactionId,
      externalTransactionId: body.externalTransactionId,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
    });
    const byExternal = await call('GET', `/providers/provider-a/wagering/transactions/${String(body.externalTransactionId)}`);
    expect(byExternal.body.transactionId).toBe(created.body.transactionId);

    const tokenB = await http.token({ provider_id: 'provider-b' });
    expect((await call('GET', `/wagering/transactions/${created.body.transactionId}`, { token: tokenB })).status).toBe(404);
    expect(
      (await call('GET', `/providers/provider-a/wagering/transactions/${String(body.externalTransactionId)}`, { token: tokenB })).status,
    ).toBe(403);
    expect((await call('GET', `/providers/provider-a/wagering/transactions/unknown`)).status).toBe(404);
  });
});

describe('503 em falha transitória', () => {
  test('banco indisponível → 503 com Retry-After, sem colapsar em 500', async () => {
    class DownUnitOfWork extends UnitOfWork {
      transaction<T>(): Promise<T> {
        return Promise.reject(new TransientInfrastructureError('down', 'connection'));
      }
      read<T>(): Promise<T> {
        return Promise.reject(new TransientInfrastructureError('down', 'connection'));
      }
    }
    const down = await startHttpApp([{ provide: UnitOfWork, useValue: new DownUnitOfWork() }]);
    try {
      const token = await down.token();
      const res = await fetch(`${down.baseUrl}/wallets/${randomUUID()}`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('TRANSIENT_INFRASTRUCTURE_ERROR');
    } finally {
      await down.close();
    }
  });
});
