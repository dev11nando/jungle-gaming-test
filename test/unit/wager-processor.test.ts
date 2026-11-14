import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { processWager, type ProcessWagerOutcome } from '../../src/domain/services/wager-processor';
import { WagerTransaction } from '../../src/domain/entities/wager-transaction';
import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/entities/wagering-types';
import type { Wallet } from '../../src/domain/entities/wallet';
import { openWallet, T0, wager } from '../support/domain-fixtures';

function run(
  wallet: Wallet,
  transaction: WagerTransaction,
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
  now = T0,
): ProcessWagerOutcome {
  return processWager({ transaction, wallet, reference, referenceAlreadyReversed, newLedgerEntryId: randomUUID, now });
}

function processedBet(wallet: Wallet, amount: string, id = `bet-${randomUUID()}`): WagerTransaction {
  const bet = wager(wallet, K.Bet, amount, { externalTransactionId: id });
  expect(run(wallet, bet).type).toBe('PROCESSED');
  return bet;
}

describe('BET', () => {
  test('debita e gera um lançamento DEBIT; resultado guarda o saldo observado', () => {
    const wallet = openWallet('100.00');
    const bet = wager(wallet, K.Bet, '25.00');
    const outcome = run(wallet, bet);
    expect(outcome.type).toBe('PROCESSED');
    expect(outcome.type === 'PROCESSED' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe('75.00');
    expect(bet.status).toBe(S.Processed);
    expect(bet.resultBalance?.amount).toBe('75.00');
    expect(bet.resultWalletVersion).toBe(2);
  });

  test('saldo insuficiente → REJECTED INSUFFICIENT_FUNDS, sem lançamento', () => {
    const wallet = openWallet('100.00');
    processedBet(wallet, '80.00');
    const second = wager(wallet, K.Bet, '80.00');
    expect(run(wallet, second)).toEqual({ type: 'REJECTED', failureCode: FailureCode.InsufficientFunds });
    expect(second.status).toBe(S.Rejected);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.pullUncommittedEntries()).toHaveLength(1);
  });

  test('moeda divergente → CURRENCY_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = wager(wallet, K.Bet, '10.00', { currency: 'USD' });
    expect(run(wallet, bet)).toEqual({ type: 'REJECTED', failureCode: FailureCode.CurrencyMismatch });
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('player divergente da wallet → PLAYER_WALLET_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = wager(wallet, K.Bet, '10.00', { playerId: 'someone-else' });
    expect(run(wallet, bet)).toEqual({ type: 'REJECTED', failureCode: FailureCode.PlayerWalletMismatch });
  });
});

describe('WIN', () => {
  test('sem referência credita', () => {
    const wallet = openWallet('10.00');
    expect(run(wallet, wager(wallet, K.Win, '50.00')).type).toBe('PROCESSED');
    expect(wallet.balance.amount).toBe('60.00');
  });

  test('com referência à BET da mesma rodada credita e guarda a referência interna', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    const win = wager(wallet, K.Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(wallet, win, bet).type).toBe('PROCESSED');
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe('120.00');
  });

  test('referência de outra rodada → REFERENCE_SCOPE_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    const win = wager(wallet, K.Win, '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
      roundId: 'other-round',
    });
    expect(run(wallet, win, bet)).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceScopeMismatch });
  });
});

describe('LOSS', () => {
  test('processa sem mover saldo, sem lançamento e sem incrementar versão', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    wallet.pullUncommittedEntries();
    const loss = wager(wallet, K.Loss, '0.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(wallet, loss, bet)).toEqual({ type: 'PROCESSED' });
    expect(loss.affectsBalance()).toBe(false);
    expect(wallet.balance.amount).toBe('90.00');
    expect(wallet.version).toBe(2);
    expect(wallet.pullUncommittedEntries()).toHaveLength(0);
  });
});

describe('REFUND', () => {
  test('reverte uma BET PROCESSED com crédito do mesmo valor', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '40.00');
    const refund = wager(wallet, K.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const outcome = run(wallet, refund, bet);
    expect(outcome.type === 'PROCESSED' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('exige referência', () => {
    const wallet = openWallet('100.00');
    expect(() => wager(wallet, K.Refund, '1.00')).toThrow(expect.objectContaining({ code: 'REFERENCE_REQUIRED' }));
  });

  test('só referencia BET', () => {
    const wallet = openWallet('100.00');
    const win = wager(wallet, K.Win, '5.00', { externalTransactionId: 'win-1' });
    run(wallet, win);
    const refund = wager(wallet, K.Refund, '5.00', { referenceExternalTransactionId: 'win-1' });
    expect(run(wallet, refund, win)).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceKindNotAllowed });
  });

  test('valor diferente → AMOUNT_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '40.00');
    const refund = wager(wallet, K.Refund, '39.99', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(wallet, refund, bet)).toEqual({ type: 'REJECTED', failureCode: FailureCode.AmountMismatch });
  });

  test('segunda reversão → ALREADY_REVERSED', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '40.00');
    const refund = wager(wallet, K.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(wallet, refund, bet, true)).toEqual({ type: 'REJECTED', failureCode: FailureCode.AlreadyReversed });
    expect(wallet.balance.amount).toBe('60.00');
  });

  test('referência REJECTED → REFERENCE_NOT_PROCESSED', () => {
    const wallet = openWallet('10.00');
    const bet = wager(wallet, K.Bet, '50.00');
    run(wallet, bet);
    expect(bet.status).toBe(S.Rejected);
    const refund = wager(wallet, K.Refund, '50.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(wallet, refund, bet)).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceNotProcessed });
  });

  test('referência de outro player → REFERENCE_SCOPE_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    const otherWallet = openWallet('100.00', 'player-2');
    const refund = wager(otherWallet, K.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(otherWallet, refund, bet)).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceScopeMismatch });
  });
});

describe('ROLLBACK', () => {
  test('de BET credita', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '30.00');
    const rb = wager(wallet, K.Rollback, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(rb.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(run(wallet, rb, bet).type).toBe('PROCESSED');
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('de WIN debita', () => {
    const wallet = openWallet('0.00');
    const win = wager(wallet, K.Win, '20.00', { externalTransactionId: 'win-x' });
    run(wallet, win);
    const rb = wager(wallet, K.Rollback, '20.00', { referenceExternalTransactionId: 'win-x' });
    expect(run(wallet, rb, win).type).toBe('PROCESSED');
    expect(wallet.balance.amount).toBe('0.00');
  });

  test('de REFUND debita', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '30.00');
    const refund = wager(wallet, K.Refund, '30.00', {
      externalTransactionId: 'refund-x',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    run(wallet, refund, bet);
    const rb = wager(wallet, K.Rollback, '30.00', { referenceExternalTransactionId: 'refund-x' });
    expect(run(wallet, rb, refund).type).toBe('PROCESSED');
    expect(wallet.balance.amount).toBe('70.00');
  });

  test('não referencia LOSS', () => {
    const wallet = openWallet('100.00');
    const loss = wager(wallet, K.Loss, '0.00', { externalTransactionId: 'loss-x' });
    run(wallet, loss);
    const rb = wager(wallet, K.Rollback, '1.00', { referenceExternalTransactionId: 'loss-x' });
    expect(run(wallet, rb, loss)).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceKindNotAllowed });
  });

  test('reversão que deixaria saldo negativo → REVERSAL_WOULD_GO_NEGATIVE (≠ INSUFFICIENT_FUNDS)', () => {
    const wallet = openWallet('0.00');
    const win = wager(wallet, K.Win, '50.00', { externalTransactionId: 'win-y' });
    run(wallet, win);
    processedBet(wallet, '40.00');
    const rb = wager(wallet, K.Rollback, '50.00', { referenceExternalTransactionId: 'win-y' });
    expect(run(wallet, rb, win)).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReversalWouldGoNegative });
    expect(rb.status).toBe(S.Rejected);
    expect(rb.resultBalance?.amount).toBe('10.00');
    expect(wallet.balance.amount).toBe('10.00');
  });
});

describe('referência fora de ordem', () => {
  const policy = { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 3, ttlMs: 15 * 60_000 };

  test('referência ausente → PENDING_REFERENCE com primeira tentativa agendada', () => {
    const wallet = openWallet('100.00');
    const refund = wager(wallet, K.Refund, '10.00', { referenceExternalTransactionId: 'not-yet' });
    expect(run(wallet, refund)).toEqual({ type: 'PENDING_REFERENCE' });
    expect(refund.status).toBe(S.PendingReference);
    expect(refund.nextReferenceAttemptAt?.toISOString()).toBe('2026-07-29T15:00:01.000Z');
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('backoff exponencial e REFERENCE_NOT_FOUND ao esgotar tentativas', () => {
    const wallet = openWallet('100.00');
    const refund = wager(wallet, K.Refund, '10.00', { referenceExternalTransactionId: 'never' });
    const step = (now: Date) =>
      processWager({
        transaction: refund,
        wallet,
        referenceAlreadyReversed: false,
        newLedgerEntryId: randomUUID,
        now,
        retryPolicy: policy,
      });
    expect(step(T0).type).toBe('PENDING_REFERENCE');
    const t1 = new Date(T0.getTime() + 1_000);
    expect(step(t1).type).toBe('PENDING_REFERENCE');
    expect(refund.nextReferenceAttemptAt?.getTime()).toBe(t1.getTime() + 2_000);
    const t2 = new Date(t1.getTime() + 2_000);
    expect(step(t2).type).toBe('PENDING_REFERENCE');
    expect(refund.nextReferenceAttemptAt?.getTime()).toBe(t2.getTime() + 4_000);
    expect(step(new Date(t2.getTime() + 4_000))).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceNotFound });
    expect(refund.status).toBe(S.Rejected);
  });

  test('referência chega depois e a pendência é aplicada', () => {
    const wallet = openWallet('100.00');
    const refund = wager(wallet, K.Refund, '10.00', { referenceExternalTransactionId: 'late-bet' });
    run(wallet, refund);
    const bet = processedBet(wallet, '10.00', 'late-bet');
    expect(run(wallet, refund, bet).type).toBe('PROCESSED');
    expect(wallet.balance.amount).toBe('100.00');
  });
});

describe('estados terminais', () => {
  test('processar transação terminal é erro de programação', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '1.00');
    expect(() => run(wallet, bet)).toThrow(expect.objectContaining({ name: 'InvalidTransactionStateError' }));
    expect(() => bet.reject(FailureCode.InsufficientFunds, T0)).toThrow(
      expect.objectContaining({ name: 'InvalidTransactionStateError' }),
    );
    expect(() => bet.fail(FailureCode.PermanentProcessingError, T0)).toThrow();
  });
});
