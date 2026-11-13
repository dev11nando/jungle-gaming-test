import type { InboxMessage } from '../../messaging/domain/inbox-message';
import type { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { Money } from '../domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

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
  claimDuePendingReferences(now: Date, limit: number): Promise<string[]>;
  findPendingDependents(providerId: string, referenceExternalTransactionId: string): Promise<string[]>;
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

export abstract class UnitOfWork {
  abstract transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
  abstract read<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export abstract class IdGenerator {
  abstract next(): string;
}

export abstract class Clock {
  abstract now(): Date;
}
