import type { MoneyProps } from '../domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { ReconciliationReport } from '../application/wallet-use-cases';

export function presentWallet(w: Wallet) {
  return { id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version };
}

export function presentSubmission(tx: WagerTransaction, idempotentReplay: boolean) {
  const body: {
    transactionId: string;
    status: string;
    balance: MoneyProps | null;
    idempotentReplay: boolean;
    failureCode?: string;
  } = {
    transactionId: tx.id,
    status: tx.status,
    // Saldo observado no momento em que a transação terminou — replay devolve o original.
    balance: tx.resultBalance?.toJSON() ?? null,
    idempotentReplay,
  };
  if (tx.failureCode !== undefined) body.failureCode = tx.failureCode;
  return body;
}

export function presentTransaction(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balance: tx.resultBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export function presentLedgerEntry(e: WalletLedgerEntry) {
  return {
    id: e.id,
    transactionId: e.transactionId,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt.toISOString(),
  };
}

export function presentReconciliation(r: ReconciliationReport) {
  return {
    walletId: r.walletId,
    storedBalance: r.storedBalance.toJSON(),
    calculatedBalance: r.calculatedBalance.toJSON(),
    difference: r.difference.toJSON(),
    consistent: r.consistent,
    checkedEntries: r.checkedEntries,
  };
}
