import { InvalidTransactionStateError } from '../../../shared/domain/domain-error';
import { WagerTransaction, REFERENCE_RETRY_POLICY, type ReferenceRetryPolicy } from './wager-transaction';
import { FailureCode, LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from './wagering-types';
import { Wallet } from './wallet';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface ProcessWagerInput {
  transaction: WagerTransaction;
  /** Wallet já protegida por lock pelo chamador. */
  wallet: Wallet;
  /** Transação referenciada, resolvida por (providerId, referenceExternalTransactionId). */
  reference?: WagerTransaction;
  /** Já existe uma reversão PROCESSED (REFUND ou ROLLBACK) apontando para a referência. */
  referenceAlreadyReversed: boolean;
  newLedgerEntryId: () => string;
  now: Date;
  retryPolicy?: ReferenceRetryPolicy;
}

export type ProcessWagerOutcome =
  | { type: 'PROCESSED'; ledgerEntry?: WalletLedgerEntry }
  | { type: 'REJECTED'; failureCode: FailureCode }
  | { type: 'PENDING_REFERENCE' };

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/**
 * Serviço de domínio: aplica as regras de BET/WIN/LOSS/REFUND/ROLLBACK
 * sobre uma wallet travada. Puro — não conhece banco nem fila.
 */
export function processWager(input: ProcessWagerInput): ProcessWagerOutcome {
  const { transaction: tx, wallet, reference, now } = input;
  if (tx.isTerminal()) {
    throw new InvalidTransactionStateError(`transaction ${tx.id} is already ${tx.status}`);
  }
  if (tx.walletId !== wallet.id) {
    throw new InvalidTransactionStateError('wallet does not belong to transaction');
  }

  const reject = (code: FailureCode): ProcessWagerOutcome => {
    tx.reject(code, now, { balance: wallet.balance, walletVersion: wallet.version });
    return { type: 'REJECTED', failureCode: code };
  };

  if (tx.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }
  if (tx.playerId !== wallet.playerId) {
    return reject(FailureCode.PlayerWalletMismatch);
  }

  if (tx.referenceExternalTransactionId !== undefined) {
    if (reference === undefined || !reference.isTerminal()) {
      return waitForReference(tx, now, input.retryPolicy ?? REFERENCE_RETRY_POLICY, reject);
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }
    if (
      reference.providerId !== tx.providerId ||
      reference.playerId !== tx.playerId ||
      reference.walletId !== tx.walletId ||
      reference.money.currency !== tx.money.currency ||
      reference.roundId !== tx.roundId
    ) {
      return reject(FailureCode.ReferenceScopeMismatch);
    }
    const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
    if (!allowed.includes(reference.kind)) {
      return reject(FailureCode.ReferenceKindNotAllowed);
    }
    if (tx.isReversal()) {
      if (!reference.money.equals(tx.money)) {
        return reject(FailureCode.AmountMismatch);
      }
      if (input.referenceAlreadyReversed) {
        return reject(FailureCode.AlreadyReversed);
      }
    }
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, now, { balance: wallet.balance, walletVersion: wallet.version });
    return { type: 'PROCESSED' };
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return reject(tx.isReversal() ? FailureCode.ReversalWouldGoNegative : FailureCode.InsufficientFunds);
  }

  const ledgerEntry = wallet.move(direction, tx.money, {
    transactionId: tx.id,
    entryId: input.newLedgerEntryId(),
    at: now,
  });
  tx.markProcessed(reference?.id, now, { balance: wallet.balance, walletVersion: wallet.version });
  return { type: 'PROCESSED', ledgerEntry };
}

function waitForReference(
  tx: WagerTransaction,
  now: Date,
  policy: ReferenceRetryPolicy,
  reject: (code: FailureCode) => ProcessWagerOutcome,
): ProcessWagerOutcome {
  if (tx.status === WagerTransactionStatus.Pending) {
    tx.markPendingReference(now, policy);
    return { type: 'PENDING_REFERENCE' };
  }
  return tx.scheduleReferenceRetry(now, policy) ? { type: 'PENDING_REFERENCE' } : reject(FailureCode.ReferenceNotFound);
}
