import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../src/domain/entities/inbox-message';
import { OutboxMessage } from '../../src/domain/entities/outbox-message';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../../src/domain/events/wagering-events';
import { canonicalJson, wagerPayloadHash } from '../../src/domain/services/payload-hash';
import { WagerTransaction } from '../../src/domain/entities/wager-transaction';
import { FailureCode, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/domain/entities/wagering-types';
import { brl, openWallet, T0, wager } from '../support/domain-fixtures';

const payload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('idempotência — payload hash', () => {
  test('JSON canônico ordena chaves e omite undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: undefined } })).toBe('{"a":{"d":"x"},"b":1}');
  });

  test('mesma operação com chaves em outra ordem → mesmo hash', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'w1',
      playerId: 'p1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(payload));
    expect(wagerPayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('payload divergente com a mesma key → hash diferente (conflito, não replay)', () => {
    const tx = WagerTransaction.create({
      ...payload,
      id: 'id-1',
      kind: K.Bet,
      idempotencyKey: 'provider-a:transaction-123',
      payloadHash: wagerPayloadHash(payload),
      money: brl('25.00'),
      createdAt: T0,
    });
    const divergent = wagerPayloadHash({ ...payload, money: { amount: '26.00', currency: 'BRL' } });
    expect(tx.matchesPayload(wagerPayloadHash(payload))).toBe(true);
    expect(tx.matchesPayload(divergent)).toBe(false);
    expect(wagerPayloadHash({ ...payload, referenceExternalTransactionId: 'x' })).not.toBe(wagerPayloadHash(payload));
  });
});

describe('WagerTransaction', () => {
  test('nasce PENDING e não é terminal', () => {
    const wallet = openWallet();
    const tx = wager(wallet, K.Bet, '1.00');
    expect(tx.status).toBe(S.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  test('valida campos obrigatórios, valor e autorreferência', () => {
    const wallet = openWallet();
    expect(() => wager(wallet, K.Bet, '0.00')).toThrow(expect.objectContaining({ code: 'INVALID_MONEY' }));
    expect(() => wager(wallet, K.Rollback, '1.00')).toThrow(expect.objectContaining({ code: 'REFERENCE_REQUIRED' }));
    expect(() =>
      wager(wallet, K.Refund, '1.00', { externalTransactionId: 'same', referenceExternalTransactionId: 'same' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_REFERENCE' }));
    expect(() =>
      WagerTransaction.create({
        ...payload,
        id: 'x',
        kind: K.Bet,
        roundId: '',
        idempotencyKey: 'k',
        payloadHash: 'h',
        money: brl('1.00'),
        createdAt: T0,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_FIELD' }));
  });

  test('consultas de domínio', () => {
    const wallet = openWallet();
    expect(wager(wallet, K.Loss, '0.00').affectsBalance()).toBe(false);
    expect(wager(wallet, K.Bet, '1.00').requiresReference()).toBe(false);
    expect(wager(wallet, K.Refund, '1.00', { referenceExternalTransactionId: 'r' }).requiresReference()).toBe(true);
  });

  test('OPENING nasce PROCESSED no escopo interno', () => {
    const tx = WagerTransaction.opening({ id: 't', walletId: 'w', playerId: 'p', money: brl('10.00'), payloadHash: 'h', at: T0 });
    expect(tx.status).toBe(S.Processed);
    expect(tx.providerId).toBe('internal');
    expect(tx.resultWalletVersion).toBe(1);
  });

  test('rehydrate não revalida transições', () => {
    const wallet = openWallet();
    const tx = wager(wallet, K.Bet, '1.00');
    tx.reject(FailureCode.InsufficientFunds, T0);
    const copy = WagerTransaction.rehydrate({
      ...tx,
      money: tx.money,
      status: tx.status,
      failureCode: tx.failureCode,
      referenceAttempts: 0,
      referenceExternalTransactionId: undefined,
    });
    expect(copy.status).toBe(S.Rejected);
    expect(copy.isTerminal()).toBe(true);
  });
});

describe('eventos e outbox', () => {
  test('envelope serializado com MoneyProps e eventType/version do tipo', () => {
    const wallet = openWallet('100.00');
    const tx = wager(wallet, K.Bet, '25.00');
    const entry = wallet.debit(tx.money, { transactionId: tx.id, entryId: 'e', at: T0 });
    tx.markProcessed(undefined, T0, { balance: wallet.balance, walletVersion: wallet.version });
    let n = 0;
    const ctx = { newEventId: () => `evt-${++n}`, correlationId: 'corr', occurredAt: T0 };
    const changed = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(changed as unknown).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: tx.id,
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    const processed = OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx));
    expect(processed.id).toBe('evt-2');
    expect(processed.eventType).toBe('WagerTransactionProcessed');
    expect((processed.payload.data as { balance: unknown }).balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(processed.isDue(T0)).toBe(true);
  });

  test('outbox: retry com backoff e publicação terminal', () => {
    const tx = wager(openWallet(), K.Loss, '0.00');
    const msg = OutboxMessage.enqueue(
      WagerTransactionProcessed.from(tx, { newEventId: () => 'e', correlationId: 'c', occurredAt: T0 }),
    );
    msg.scheduleRetry(T0);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt?.getTime()).toBe(T0.getTime() + 1_000);
    msg.scheduleRetry(T0);
    expect(msg.nextAttemptAt?.getTime()).toBe(T0.getTime() + 2_000);
    expect(msg.isDue(T0)).toBe(false);
    msg.markPublished(T0);
    expect(msg.isPending()).toBe(false);
    expect(() => msg.markPublished(T0)).toThrow();
    expect(OutboxMessage.backoffMs(100)).toBe(300_000);
  });

  test('inbox: processamento único e conflito de payload', () => {
    const inbox = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'h', receivedAt: T0 });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(T0);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.matchesPayload('other')).toBe(false);
    expect(() => inbox.markProcessed(T0)).toThrow();
  });
});
