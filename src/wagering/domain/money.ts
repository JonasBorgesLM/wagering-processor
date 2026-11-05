import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Strict on purpose (FR-01). Normalizing "25.5" to "25.50" would let two spellings
// of one amount produce different idempotency hashes for the same operation.
// 18 integer digits is what numeric(20,2) holds (FR-05).
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,17})\.[0-9]{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const MINOR_UNITS_PER_UNIT = 100n;
const MAX_STORABLE_MINOR_UNITS = 10n ** 20n - 1n;

/**
 * An exact, immutable amount in one currency, held as bigint minor units with a
 * fixed scale of two (ADR-0004). There is no division and no rounding path, so
 * no operation here can lose a cent.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parses a contract value. Negative amounts are refused here; only arithmetic can produce one (FR-04). */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    assertCurrency(currency);
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`Invalid amount: expected a decimal string with two decimals`);
    }
    return new Money(BigInt(amount.replace(".", "")), currency);
  }

  static zero(currency: string): Money {
    assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Different currencies are simply not equal. Only ordering and arithmetic have no answer across them. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  /** A sum of valid amounts can outgrow numeric(20,2), and settlement must refuse it rather than fail at the database. */
  fitsStorage(): boolean {
    const magnitude = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    return magnitude <= MAX_STORABLE_MINOR_UNITS;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const sign = this.minorUnits < 0n ? "-" : "";
    const magnitude = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const units = magnitude / MINOR_UNITS_PER_UNIT;
    const cents = (magnitude % MINOR_UNITS_PER_UNIT).toString().padStart(2, "0");
    return `${sign}${units}.${cents}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`Cannot combine ${this.currency} with ${other.currency}`);
    }
  }
}

function assertCurrency(currency: string): void {
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError("Invalid currency: expected a three-letter ISO-4217 code");
  }
}
