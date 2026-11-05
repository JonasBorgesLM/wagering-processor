import {
  BalanceLimitExceededError,
  InsufficientFundsError,
  InvalidMovementError,
  InvalidWalletError,
} from "./errors";
import { assertDate, assertText } from "./guards";
import { Money } from "./money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What a balance change needs to be recorded. Ids come from outside so the domain stays deterministic. */
export interface Movement {
  transactionId: string;
  entryId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Required when the initial balance is positive, and refused when it is zero. */
  opening?: { transactionId: string; entryId: string };
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Absent for a zero opening: no money moved, so there is nothing to record. */
  openingEntry: WalletLedgerEntry | undefined;
}

/**
 * The aggregate that owns a balance. Every change returns the ledger entry that
 * records it, and the entry is built before the state changes, so a failure
 * leaves the wallet exactly as it was (FR-14).
 *
 * `version` starts at 1 and rises only when the balance changes (FR-13).
 * Opening is not a change: it sets the first state.
 */
export class Wallet {
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this._createdAt = new Date(createdAt);
    this._updatedAt = new Date(updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  static open(props: OpenWalletProps): OpenedWallet {
    assertText(props.id, "id", InvalidWalletError);
    assertText(props.playerId, "playerId", InvalidWalletError);
    assertDate(props.at, "at", InvalidWalletError);
    const { initialBalance, opening } = props;
    if (initialBalance.isNegative()) throw new InvalidWalletError("initial balance cannot be negative");

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      props.at,
      props.at,
    );
    if (initialBalance.isZero()) {
      if (opening) throw new InvalidWalletError("a zero opening records nothing, so it takes no opening ids");
      return { wallet, openingEntry: undefined };
    }
    if (!opening)
      throw new InvalidWalletError("a positive opening needs the ids of its transaction and entry");
    const openingEntry = WalletLedgerEntry.create({
      id: opening.entryId,
      walletId: props.id,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Rebuilds a stored wallet. It does not re-validate: what is stored already passed validation once. */
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

  /** Whether a debit would be accepted, so a policy can reject with a code instead of catching an error. */
  canDebit(money: Money): boolean {
    return !this._balance.isLessThan(money);
  }

  /** Whether a credit would stay within what the database column can hold (FR-05). */
  canCredit(money: Money): boolean {
    return this._balance.add(money).fitsStorage();
  }

  debit(money: Money, movement: Movement): WalletLedgerEntry {
    assertMovable(money);
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(`balance ${this._balance} cannot cover ${money}`);
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(money), money, movement);
  }

  credit(money: Money, movement: Movement): WalletLedgerEntry {
    assertMovable(money);
    if (!this.canCredit(money)) {
      throw new BalanceLimitExceededError(`crediting ${money} would exceed the storable balance`);
    }
    return this.apply(LedgerDirection.Credit, this._balance.add(money), money, movement);
  }

  // Currency conflicts need no check of their own here: Money raises CurrencyMismatchError
  // from the comparison or the sum that every path above performs before any state changes.
  private apply(
    direction: LedgerDirection,
    next: Money,
    money: Money,
    movement: Movement,
  ): WalletLedgerEntry {
    const version = this._version + 1;
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter: next,
      walletVersion: version,
      createdAt: movement.at,
    });
    this._balance = next;
    this._version = version;
    this._updatedAt = new Date(movement.at);
    return entry;
  }
}

function assertMovable(money: Money): void {
  if (!money.isPositive()) throw new InvalidMovementError("a movement must be positive");
}
