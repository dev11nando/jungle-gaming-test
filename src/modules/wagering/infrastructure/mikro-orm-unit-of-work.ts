import { LockMode, type EntityManager, type MikroORM } from '@mikro-orm/postgresql';
import {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../../../infrastructure/database/records';
import type { InboxMessage } from '../../messaging/domain/inbox-message';
import type { OutboxMessage } from '../../messaging/domain/outbox-message';
import { Money } from '../domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import { REVERSAL_KINDS, WagerTransactionStatus } from '../domain/wagering-types';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { StaleWriteError, TransientInfrastructureError, UniqueViolationError } from '../application/errors';
import {
  UnitOfWork,
  type InboxRepository,
  type LedgerPageItem,
  type LedgerRepository,
  type OutboxRepository,
  type Repositories,
  type WagerTransactionRepository,
  type WalletRepository,
} from '../application/ports';
import {
  inboxFromRecord,
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  transactionFromRecord,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from './mappers';

const LOCK_TIMEOUT = '5s';
const STATEMENT_TIMEOUT = '15s';

const TRANSIENT_SQLSTATE = /^(08|40001|40P01|55P03|57014|57P0[1-3]|53)/;
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  async transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
        await em.execute(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
        return work(repositories(em));
      });
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }

  async read<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await work(repositories(this.orm.em.fork()));
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}

export function translatePersistenceError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (error instanceof UniqueViolationError || error instanceof TransientInfrastructureError) return error;
  const e = error as Error & { code?: string; constraint?: string };
  if (e.code === '23505') {
    return new UniqueViolationError(e.constraint);
  }
  if (typeof e.code === 'string' && (TRANSIENT_SQLSTATE.test(e.code) || TRANSIENT_NODE_CODES.has(e.code))) {
    return new TransientInfrastructureError('database temporarily unavailable', reasonFor(e.code), error);
  }
  if (e.name === 'ConnectionException' || /Connection terminated|timeout exceeded when trying to connect/i.test(e.message)) {
    return new TransientInfrastructureError('database temporarily unavailable', 'connection', error);
  }
  return error;
}

function reasonFor(code: string): string {
  if (code === '55P03') return 'lock_timeout';
  if (code === '40P01') return 'deadlock';
  if (code === '40001') return 'serialization';
  if (code === '57014') return 'statement_timeout';
  return 'connection';
}

function repositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, walletToRecord(wallet));
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id }, { disableIdentityMap: true });
    return record ? walletFromRecord(record) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return record ? walletFromRecord(record) : undefined;
  }

  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new StaleWriteError(`wallet ${wallet.id} changed concurrently (expected version ${expectedVersion})`);
    }
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, transactionToRecord(tx));
  }

  async update(tx: WagerTransaction): Promise<void> {
    const r = transactionToRecord(tx);
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id },
      {
        status: r.status,
        referenceTransactionId: r.referenceTransactionId,
        failureCode: r.failureCode,
        resultBalanceAmount: r.resultBalanceAmount,
        resultWalletVersion: r.resultWalletVersion,
        referenceAttempts: r.referenceAttempts,
        nextReferenceAttemptAt: r.nextReferenceAttemptAt,
        processedAt: r.processedAt,
        completedAt: r.completedAt,
      },
    );
    if (affected !== 1) {
      throw new StaleWriteError(`wager transaction ${tx.id} not found for update`);
    }
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.one({ id });
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return record ? transactionFromRecord(record) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    return this.one({ idempotencyKey: key });
  }

  async findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.one({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [...REVERSAL_KINDS] },
    });
    return count > 0;
  }

  async claimDuePendingReferences(now: Date, limit: number): Promise<string[]> {
    const rows = await this.em.execute<{ id: string }[]>(
      `select id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= ?
        order by next_reference_attempt_at
        limit ?
        for update skip locked`,
      [now, limit],
    );
    return rows.map((row) => row.id);
  }

  async findPendingDependents(providerId: string, referenceExternalTransactionId: string): Promise<string[]> {
    const rows = await this.em.execute<{ id: string }[]>(
      `select id from wager_transactions
        where provider_id = ? and reference_external_transaction_id = ? and status = 'PENDING_REFERENCE'
        order by created_at`,
      [providerId, referenceExternalTransactionId],
    );
    return rows.map((row) => row.id);
  }

  private async one(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, where, { disableIdentityMap: true });
    return record ? transactionFromRecord(record) : undefined;
  }
}

interface LedgerRow {
  position: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  wallet_version: number;
  created_at: Date;
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entries: readonly WalletLedgerEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.em.insertMany(LedgerEntryRecord, entries.map(ledgerEntryToRecord));
  }

  async page(walletId: string, afterPosition: string | undefined, limit: number): Promise<LedgerPageItem[]> {
    const rows = await this.em.execute<LedgerRow[]>(
      `select position::text as position, id, wallet_id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after, wallet_version, created_at
         from wallet_ledger_entries
        where wallet_id = ? and position > ?
        order by position
        limit ?`,
      [walletId, afterPosition ?? '0', limit],
    );
    return rows.map((row) => ({
      position: row.position,
      entry: ledgerEntryFromRecord({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        amount: row.amount,
        currency: row.currency,
        balanceBefore: row.balance_before,
        balanceAfter: row.balance_after,
        walletVersion: row.wallet_version,
        createdAt: new Date(row.created_at),
      }),
    }));
  }

  async summarize(walletId: string, currency: string): Promise<{ balance: Money; entries: number }> {
    const rows = await this.em.execute<{ balance: string; entries: number }[]>(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as balance,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    const row = rows[0] ?? { balance: '0', entries: 0 };
    return { balance: Money.fromStored(row.balance, currency), entries: Number(row.entries) };
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(
      OutboxRecord,
      messages.map((m) => ({
        id: m.id,
        aggregateId: m.aggregateId,
        eventType: m.eventType,
        payload: { ...m.payload },
        occurredAt: m.occurredAt,
        attempts: m.attempts,
        nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
        publishedAt: m.publishedAt ?? null,
      })),
    );
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxRecord, { consumerName, messageId }, { disableIdentityMap: true });
    return record ? inboxFromRecord(record) : undefined;
  }

  async insertProcessed(message: InboxMessage, transactionId: string | undefined): Promise<void> {
    await this.em.insert(InboxRecord, {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      transactionId: transactionId ?? null,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
  }
}
