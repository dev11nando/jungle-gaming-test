import { InvalidInputError } from '../errors/domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class CurrencyMismatchError extends InvalidInputError {
  constructor(left: string, right: string) {
    super('CURRENCY_MISMATCH', `currency mismatch: ${left} vs ${right}`);
  }
}

const SCALE = 2;
const FACTOR = 100n;
const INPUT_AMOUNT = /^(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
const STORED_AMOUNT = /^-?(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
// Teto de numeric(19,2).
const MAX_MINOR = 10n ** 19n - 1n;

export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidInputError('INVALID_MONEY', 'money must be an object');
    }
    const currency = Money.parseCurrency(props.currency);
    if (typeof props.amount !== 'string' || !INPUT_AMOUNT.test(props.amount)) {
      throw new InvalidInputError(
        'INVALID_MONEY',
        'amount must be a non-negative decimal string with at most 2 decimal places',
      );
    }
    return new Money(Money.toMinor(props.amount), currency);
  }

  static fromStored(amount: string, currency: string): Money {
    if (!STORED_AMOUNT.test(amount)) {
      throw new InvalidInputError('INVALID_MONEY', `invalid stored amount: ${amount}`);
    }
    return new Money(Money.toMinor(amount), Money.parseCurrency(currency));
  }

  static fromMinor(minor: bigint, currency: string): Money {
    return Money.checked(minor, Money.parseCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  get minorUnits(): bigint {
    return this.minor;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  get amount(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const units = abs / FACTOR;
    const cents = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${units}.${cents}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static checked(minor: bigint, currency: string): Money {
    if (minor > MAX_MINOR || minor < -MAX_MINOR) {
      throw new InvalidInputError('INVALID_MONEY', 'amount exceeds numeric(19,2)');
    }
    return new Money(minor, currency);
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidInputError('INVALID_MONEY', 'currency must be an ISO-4217 code (3 uppercase letters)');
    }
    return currency;
  }

  private static toMinor(amount: string): bigint {
    const negative = amount.startsWith('-');
    const unsigned = negative ? amount.slice(1) : amount;
    const [units = '0', fraction = ''] = unsigned.split('.');
    const minor = BigInt(units) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
    return negative ? -minor : minor;
  }
}
