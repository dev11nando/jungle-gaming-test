import type { EventContext } from '../../../shared/domain/integration-event';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wagering-events';
import { processWager, type ProcessWagerOutcome } from '../domain/wager-processor';
import type { ReferenceRetryPolicy, WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { Repositories } from './ports';

export async function applyToLockedWallet(params: {
  repos: Repositories;
  transaction: WagerTransaction;
  wallet: Wallet;
  isNew: boolean;
  newId: () => string;
  events: EventContext;
  retryPolicy?: ReferenceRetryPolicy;
}): Promise<ProcessWagerOutcome> {
  const { repos, transaction: tx, wallet, events } = params;

  const reference =
    tx.referenceExternalTransactionId === undefined
      ? undefined
      : await repos.transactions.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId);
  const referenceAlreadyReversed =
    reference !== undefined && tx.isReversal() ? await repos.transactions.hasProcessedReversal(reference.id) : false;

  const versionBefore = wallet.version;
  const outcome = processWager({
    transaction: tx,
    wallet,
    reference,
    referenceAlreadyReversed,
    newLedgerEntryId: params.newId,
    now: events.occurredAt,
    retryPolicy: params.retryPolicy,
  });

  // Ordem explícita: transação (alvo das FKs) → saldo → ledger → outbox.
  if (params.isNew) {
    await repos.transactions.insert(tx);
  } else {
    await repos.transactions.update(tx);
  }

  const messages: OutboxMessage[] = [];
  if (outcome.type === 'PROCESSED') {
    if (outcome.ledgerEntry !== undefined) {
      await repos.wallets.updateBalance(wallet, versionBefore);
      await repos.ledger.append(wallet.pullUncommittedEntries());
      messages.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, events)));
    }
    messages.push(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, events)));
  } else if (outcome.type === 'REJECTED') {
    messages.push(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, events)));
  } else if (params.isNew) {
    messages.push(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, events)));
  }
  await repos.outbox.enqueue(messages);

  // Pendências que esperavam por esta transação são reavaliadas já, sem esperar o backoff.
  if (tx.isTerminal()) {
    await repos.transactions.wakePendingDependents(tx.providerId, tx.externalTransactionId, events.occurredAt);
  }
  return outcome;
}
