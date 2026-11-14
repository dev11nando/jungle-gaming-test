import type { Clock, IdGenerator, UnitOfWork } from '../contracts';
import type { Money } from '../entities/money';
import { OutboxMessage } from '../entities/outbox-message';
import { WagerTransaction } from '../entities/wager-transaction';
import { Wallet } from '../entities/wallet';
import type { WalletLedgerEntry } from '../entities/wallet-ledger-entry';
import { ConflictError, UniqueViolationError } from '../errors/application-errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../events/wagering-events';
import { canonicalJson, sha256Hex } from '../services/payload-hash';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
}

export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
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
