import { InvariantViolationError } from '../../../shared/domain/domain-error';
import { Money } from './money';
import { LedgerDirection } from './wagering-types';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Versão da wallet depois deste lançamento. */
  walletVersion: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento imutável. Não há campo mutável nem método de transição:
 * todos os campos são `readonly` e o objeto é congelado.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.build(props);
    if (!entry.money.isPositive()) {
      throw new InvariantViolationError('LEDGER_AMOUNT_NOT_POSITIVE', 'ledger amount must be positive');
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new InvariantViolationError('NEGATIVE_BALANCE', 'ledger balance cannot be negative');
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError('LEDGER_UNBALANCED', 'balanceBefore ± money must equal balanceAfter');
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito com sinal no saldo: +money para crédito, -money para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  private static build(p: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      p.id,
      p.walletId,
      p.transactionId,
      p.direction,
      p.money,
      p.balanceBefore,
      p.balanceAfter,
      p.walletVersion,
      new Date(p.createdAt.getTime()),
    );
  }
}
