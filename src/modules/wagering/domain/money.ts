import { InvalidInputError } from '../../../shared/domain/domain-error';

/** Contrato de borda (HTTP, SQS, eventos). */
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
/** Inteiro sem sinal, opcionalmente com 1 ou 2 casas. Sem expoente, sem espaços, sem "+". */
const INPUT_AMOUNT = /^(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
/** Mesma gramática, com sinal opcional — usada só para reidratar valores já persistidos. */
const STORED_AMOUNT = /^-?(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
/** Teto de numeric(19,2): 17 dígitos inteiros. */
const MAX_MINOR = 10n ** 19n - 1n;

/**
 * Valor monetário imutável. Internamente um `bigint` de unidades menores (centavos),
 * escala fixa 2. Nenhuma operação usa `number`.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Entrada de contrato: rejeita negativo, mais de 2 casas, notação científica, NaN, Infinity. */
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

  /** Reidratação de valor persistido (numeric como string). Aceita sinal. */
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

  /** Decimal com escala fixa 2, ex.: "25.00", "-3.10". */
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
