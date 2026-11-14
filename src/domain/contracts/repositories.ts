import type { InboxMessage } from '../entities/inbox-message';
import type { OutboxMessage } from '../entities/outbox-message';
import type { Money } from '../entities/money';
import type { WagerTransaction } from '../entities/wager-transaction';
import type { Wallet } from '../entities/wallet';
import type { WalletLedgerEntry } from '../entities/wallet-ledger-entry';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  lockById(id: string): Promise<Wallet | undefined>;
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  insert(tx: WagerTransaction): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  lockById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  findDuePendingReferences(now: Date, limit: number): Promise<string[]>;
  wakePendingDependents(providerId: string, referenceExternalTransactionId: string, now: Date): Promise<void>;
}

export interface LedgerPageItem {
  position: string;
  entry: WalletLedgerEntry;
}

export interface LedgerRepository {
  append(entries: readonly WalletLedgerEntry[]): Promise<void>;
  page(walletId: string, afterPosition: string | undefined, limit: number): Promise<LedgerPageItem[]>;
  summarize(walletId: string, currency: string): Promise<{ balance: Money; entries: number }>;
}

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  insertProcessed(message: InboxMessage, transactionId: string | undefined): Promise<void>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

// Uma chamada de transaction() = uma transação SQL; tudo o que os repositórios gravam é confirmado junto.
export interface UnitOfWork {
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
  read<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
