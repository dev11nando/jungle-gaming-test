import { Inject, Injectable, Logger } from '@nestjs/common';
import { InvalidInputError } from '../../../shared/domain/domain-error';
import { METRIC, Metrics } from '../../../shared/application/metrics';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/wagering-events';
import type { Money } from '../domain/money';
import { sha256Hex, canonicalJson } from '../domain/payload-hash';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { ConflictError, NotFoundError, UniqueViolationError } from './errors';
import { Clock, IdGenerator, UnitOfWork } from './ports';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
}

@Injectable()
export class OpenWallet {
  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(IdGenerator) private readonly ids: IdGenerator,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  async execute(cmd: OpenWalletCommand, ctx: { correlationId: string }): Promise<Wallet> {
    const now = this.clock.now();
    const walletId = this.ids.next();
    const positive = cmd.initialBalance.isPositive();
    const openingId = this.ids.next();
    const wallet = Wallet.open({
      id: walletId,
      playerId: cmd.playerId,
      initialBalance: cmd.initialBalance,
      at: now,
      opening: positive ? { transactionId: openingId, entryId: this.ids.next() } : undefined,
    });

    try {
      await this.uow.transaction(async (repos) => {
        await repos.wallets.insert(wallet);
        if (!positive) return;
        const opening = WagerTransaction.opening({
          id: openingId,
          walletId,
          playerId: cmd.playerId,
          money: cmd.initialBalance,
          payloadHash: sha256Hex(canonicalJson({ walletId, money: { ...cmd.initialBalance.toJSON() } })),
          at: now,
        });
        await repos.transactions.insert(opening);
        const entries = wallet.pullUncommittedEntries();
        await repos.ledger.append(entries);
        const events = { newEventId: () => this.ids.next(), correlationId: ctx.correlationId, occurredAt: now };
        const [entry] = entries as [WalletLedgerEntry];
        await repos.outbox.enqueue([
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, events)),
          OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, events)),
        ]);
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === 'wallets_player_currency_uq') {
        throw new ConflictError('WALLET_ALREADY_EXISTS', 'a wallet already exists for this player and currency');
      }
      throw error;
    }
    return wallet;
  }
}

export interface LedgerPage {
  items: WalletLedgerEntry[];
  nextCursor: string | undefined;
}

const MAX_PAGE = 200;

@Injectable()
export class WalletQueries {
  constructor(@Inject(UnitOfWork) private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read((r) => r.wallets.findById(walletId));
    if (wallet === undefined) throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
    return wallet;
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw new InvalidInputError('INVALID_FIELD', `limit must be an integer between 1 and ${MAX_PAGE}`);
    }
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    await this.getWallet(walletId);
    const rows = await this.uow.read((r) => r.ledger.page(walletId, after, limit + 1));
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => row.entry),
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.position) : undefined,
    };
  }

  async getTransaction(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((r) => r.transactions.findById(transactionId));
    if (tx === undefined) throw new NotFoundError('TRANSACTION_NOT_FOUND', `transaction ${transactionId} not found`);
    return tx;
  }

  async getByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((r) => r.transactions.findByProviderExternalId(providerId, externalTransactionId));
    if (tx === undefined) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'transaction not found');
    return tx;
  }
}

export function encodeCursor(position: string): string {
  return Buffer.from(`v1:${position}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const decoded = /^[A-Za-z0-9_-]{1,64}$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
  const match = /^v1:(\d{1,19})$/.exec(decoded);
  if (match?.[1] === undefined) throw new InvalidInputError('INVALID_CURSOR', 'cursor is invalid');
  return match[1];
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWallet {
  private readonly logger = new Logger(ReconcileWallet.name);

  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string, ctx: { correlationId: string }): Promise<ReconciliationReport> {
    const report = await this.uow.transaction(async (repos) => {
      const wallet = await repos.wallets.lockById(walletId);
      if (wallet === undefined) throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
      const summary = await repos.ledger.summarize(walletId, wallet.currency);
      const difference = wallet.balance.subtract(summary.balance);
      return {
        walletId,
        storedBalance: wallet.balance,
        calculatedBalance: summary.balance,
        difference,
        consistent: difference.isZero(),
        checkedEntries: summary.entries,
      };
    });
    if (!report.consistent) {
      this.metrics.increment(METRIC.reconciliationDivergences);
      this.logger.error({
        msg: 'wallet balance diverges from ledger',
        correlationId: ctx.correlationId,
        walletId,
        difference: report.difference.amount,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}
