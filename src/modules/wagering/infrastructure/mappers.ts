import type { InboxRecord, LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from '../../../infrastructure/database/records';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import { Money } from '../domain/money';
import { WagerTransaction } from '../domain/wager-transaction';
import type { FailureCode, LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from '../domain/wagering-types';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

const opt = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

export function walletFromRecord(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: Money.fromStored(r.balanceAmount, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecord(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balanceAmount: w.balance.amount,
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function transactionFromRecord(r: WagerTransactionRecord): WagerTransaction {
  const resultBalance = opt(r.resultBalanceAmount);
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: Money.fromStored(r.amount, r.currency),
    referenceExternalTransactionId: opt(r.referenceExternalTransactionId),
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: opt(r.referenceTransactionId),
    failureCode: opt(r.failureCode) as FailureCode | undefined,
    processedAt: opt(r.processedAt),
    completedAt: opt(r.completedAt),
    resultBalance: resultBalance === undefined ? undefined : Money.fromStored(resultBalance, r.currency),
    resultWalletVersion: opt(r.resultWalletVersion),
    referenceAttempts: r.referenceAttempts,
    nextReferenceAttemptAt: opt(r.nextReferenceAttemptAt),
  });
}

/** O saldo resultante é gravado na moeda da wallet (que pode diferir da operação rejeitada por CURRENCY_MISMATCH). */
export function transactionToRecord(tx: WagerTransaction): WagerTransactionRecord {
  const resultCurrencyMatches = tx.resultBalance === undefined || tx.resultBalance.currency === tx.money.currency;
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.amount,
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    // Em CURRENCY_MISMATCH o saldo observado está em outra moeda; não o gravamos com a moeda errada.
    resultBalanceAmount: resultCurrencyMatches ? (tx.resultBalance?.amount ?? null) : null,
    resultWalletVersion: tx.resultWalletVersion ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
    createdAt: tx.createdAt,
    processedAt: tx.processedAt ?? null,
    completedAt: tx.completedAt ?? null,
  };
}

export function ledgerEntryFromRecord(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: Money.fromStored(r.amount, r.currency),
    balanceBefore: Money.fromStored(r.balanceBefore, r.currency),
    balanceAfter: Money.fromStored(r.balanceAfter, r.currency),
    walletVersion: r.walletVersion,
    createdAt: r.createdAt,
  });
}

export function ledgerEntryToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: e.money.amount,
    currency: e.money.currency,
    balanceBefore: e.balanceBefore.amount,
    balanceAfter: e.balanceAfter.amount,
    walletVersion: e.walletVersion,
    createdAt: e.createdAt,
  };
}

export function inboxFromRecord(r: InboxRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: r.consumerName,
    messageId: r.messageId,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    processedAt: opt(r.processedAt),
  });
}
