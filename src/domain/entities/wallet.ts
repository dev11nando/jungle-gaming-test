import { InvalidInputError, InvariantViolationError } from '../errors/domain-error';
import { CurrencyMismatchError, Money } from './money';
import { LedgerDirection } from './wagering-types';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LedgerMovement {
  transactionId: string;
  entryId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  opening?: { transactionId: string; entryId: string };
}

export class InsufficientFundsError extends InvariantViolationError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 'insufficient funds');
  }
}

export class Wallet {
  private readonly _uncommittedEntries: WalletLedgerEntry[] = [];

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (typeof props.playerId !== 'string' || props.playerId.trim() === '') {
      throw new InvalidInputError('INVALID_PLAYER_ID', 'playerId is required');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvariantViolationError('NEGATIVE_BALANCE', 'initial balance cannot be negative');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, Money.zero(currency), 1, props.at, props.at);

    if (props.initialBalance.isPositive()) {
      if (props.opening === undefined) {
        throw new InvariantViolationError('OPENING_REQUIRED', 'positive initial balance requires an OPENING transaction');
      }
      const entry = WalletLedgerEntry.create({
        id: props.opening.entryId,
        walletId: wallet.id,
        transactionId: props.opening.transactionId,
        direction: LedgerDirection.Credit,
        money: props.initialBalance,
        balanceBefore: wallet._balance,
        balanceAfter: props.initialBalance,
        walletVersion: 1,
        createdAt: props.at,
      });
      wallet._balance = props.initialBalance;
      wallet._uncommittedEntries.push(entry);
    }
    return wallet;
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, movement: LedgerMovement): WalletLedgerEntry {
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, money, movement);
  }

  credit(money: Money, movement: LedgerMovement): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, movement);
  }

  move(direction: LedgerDirection, money: Money, movement: LedgerMovement): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(money, movement) : this.credit(money, movement);
  }

  pullUncommittedEntries(): WalletLedgerEntry[] {
    return this._uncommittedEntries.splice(0, this._uncommittedEntries.length);
  }

  private apply(direction: LedgerDirection, money: Money, movement: LedgerMovement): WalletLedgerEntry {
    if (!money.isPositive()) {
      throw new InvariantViolationError('LEDGER_AMOUNT_NOT_POSITIVE', 'movement amount must be positive');
    }
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const nextVersion = this._version + 1;
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: nextVersion,
      createdAt: movement.at,
    });
    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = movement.at;
    this._uncommittedEntries.push(entry);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
