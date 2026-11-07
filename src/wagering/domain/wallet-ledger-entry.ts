import { CurrencyMismatchError, InvalidLedgerEntryError } from "./errors";
import { assertDate, assertText } from "./guards";
import type { Money } from "./money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** The wallet version this entry produced. Strictly increasing per wallet (FR-15). */
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * One movement of money, recorded once and never changed. Immutability is
 * structural: every field is read-only, the instance is frozen, the date is
 * copied in and out, and there is no method that transitions it (§6.4).
 */
export class WalletLedgerEntry {
  private readonly _createdAt: Date;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    createdAt: Date,
  ) {
    this._createdAt = new Date(createdAt);
    Object.freeze(this);
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  /** Validates the arithmetic, so an entry that does not add up cannot exist. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    assertText(props.id, "id", InvalidLedgerEntryError);
    assertText(props.walletId, "walletId", InvalidLedgerEntryError);
    assertText(props.transactionId, "transactionId", InvalidLedgerEntryError);
    assertDate(props.createdAt, "createdAt", InvalidLedgerEntryError);
    if (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) {
      throw new InvalidLedgerEntryError("direction must be DEBIT or CREDIT");
    }
    if (!Number.isSafeInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError("walletVersion must be an integer of at least 1");
    }
    const { money, balanceBefore, balanceAfter } = props;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new CurrencyMismatchError("amount and balances of an entry must share one currency");
    }
    if (!money.isPositive()) throw new InvalidLedgerEntryError("amount must be positive");
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("a balance can never be negative");
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced())
      throw new InvalidLedgerEntryError("balanceBefore and amount do not give balanceAfter");
    return entry;
  }

  /** Rebuilds a stored entry without re-validating. Reconciliation relies on that: it asks `isBalanced()` of what is stored. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** `balanceBefore ± money === balanceAfter`. Mixed currencies are simply not balanced. */
  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
