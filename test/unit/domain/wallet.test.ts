import { describe, expect, test } from "bun:test";
import {
  BalanceLimitExceededError,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMovementError,
  InvalidWalletError,
} from "../../../src/wagering/domain/errors";
import { Money } from "../../../src/wagering/domain/money";
import { type Movement, Wallet } from "../../../src/wagering/domain/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../../src/wagering/domain/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-11-05T12:00:00.000Z");
const opening = { transactionId: "opening-t", entryId: "opening-e" };

let sequence = 0;
const movement = (at = new Date(T0.getTime() + ++sequence * 1000)): Movement => ({
  transactionId: `t${sequence}`,
  entryId: `e${sequence}`,
  at,
});

function openWith(balance: string) {
  const initialBalance = brl(balance);
  return Wallet.open({
    id: "w1",
    playerId: "p1",
    initialBalance,
    at: T0,
    ...(initialBalance.isZero() ? {} : { opening }),
  });
}

const snapshot = (wallet: Wallet) => ({
  balance: wallet.balance.toString(),
  version: wallet.version,
  updatedAt: wallet.updatedAt.toISOString(),
});

describe("Wallet.open", () => {
  test("starts at version 1 with the initial balance, in its currency (FR-11)", () => {
    const { wallet } = openWith("1000.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.currency).toBe("BRL");
    expect(wallet.createdAt.toISOString()).toBe(T0.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(T0.toISOString());
  });

  // The failure mode on the issue: opening must not make this version 2.
  test("a positive opening records one credit and still leaves version at 1 (FR-13)", () => {
    const { wallet, openingEntry } = openWith("1000.00");
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe("1000.00");
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.transactionId).toBe("opening-t");
    expect(openingEntry?.isBalanced()).toBe(true);
  });

  // FR-12
  test("a zero opening records nothing and still starts at version 1", () => {
    const { wallet, openingEntry } = openWith("0.00");
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("the first change after opening is version 2, with or without an opening entry", () => {
    for (const balance of ["50.00", "0.00"]) {
      const { wallet } = openWith(balance);
      wallet.credit(brl("10.00"), movement());
      expect(wallet.version).toBe(2);
    }
  });

  test("rejects a negative initial balance", () => {
    expect(() =>
      Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("5.00").negate(), at: T0, opening }),
    ).toThrow(InvalidWalletError);
  });

  test("a positive opening without its ids is refused, and a zero opening with ids is too", () => {
    expect(() => Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("5.00"), at: T0 })).toThrow(
      InvalidWalletError,
    );
    expect(() =>
      Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("0.00"), at: T0, opening }),
    ).toThrow(InvalidWalletError);
  });

  test("rejects empty ids and an invalid date", () => {
    expect(() => Wallet.open({ id: " ", playerId: "p1", initialBalance: brl("0.00"), at: T0 })).toThrow(
      InvalidWalletError,
    );
    expect(() => Wallet.open({ id: "w1", playerId: "", initialBalance: brl("0.00"), at: T0 })).toThrow(
      InvalidWalletError,
    );
    expect(() =>
      Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("0.00"), at: new Date("nope") }),
    ).toThrow(InvalidWalletError);
  });
});

describe("debit", () => {
  test("lowers the balance, raises the version, and returns the matching entry (FR-14)", () => {
    const { wallet } = openWith("100.00");
    const at = new Date("2026-11-05T13:00:00.000Z");
    const entry = wallet.debit(brl("80.00"), { transactionId: "bet-1", entryId: "e-bet-1", at });

    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(at.toISOString());
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("20.00");
    expect(entry.walletVersion).toBe(2);
    expect(entry.transactionId).toBe("bet-1");
    expect(entry.walletId).toBe("w1");
    expect(entry.isBalanced()).toBe(true);
  });

  test("can spend the exact balance down to zero", () => {
    const { wallet } = openWith("100.00");
    wallet.debit(brl("100.00"), movement());
    expect(wallet.balance.isZero()).toBe(true);
  });

  // The invariant behind the mandatory scenario: 100.00 cannot fund two bets of 80.00.
  test("refuses one cent more than the balance, and changes nothing", () => {
    const { wallet } = openWith("100.00");
    const before = snapshot(wallet);
    expect(() => wallet.debit(brl("100.01"), movement())).toThrow(InsufficientFundsError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test("two bets of 80.00 against 100.00: the second is refused and the balance stays at 20.00", () => {
    const { wallet } = openWith("100.00");
    wallet.debit(brl("80.00"), movement());
    expect(() => wallet.debit(brl("80.00"), movement())).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });
});

describe("credit", () => {
  test("raises the balance and the version, and returns the matching entry", () => {
    const { wallet } = openWith("20.00");
    const entry = wallet.credit(brl("80.00"), movement());
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toJSON().amount).toBe("20.00");
    expect(entry.isBalanced()).toBe(true);
  });

  // FR-05
  test("refuses a credit that would outgrow the database column, and changes nothing", () => {
    const { wallet } = openWith("999999999999999999.00");
    const before = snapshot(wallet);
    expect(() => wallet.credit(brl("1.00"), movement())).toThrow(BalanceLimitExceededError);
    expect(snapshot(wallet)).toEqual(before);
    expect(wallet.canCredit(brl("0.99"))).toBe(true);
    expect(wallet.canCredit(brl("1.00"))).toBe(false);
  });
});

describe("movements that can never apply", () => {
  test.each(["debit", "credit"] as const)(
    "%s refuses zero and negative amounts, and changes nothing",
    (kind) => {
      const { wallet } = openWith("100.00");
      const before = snapshot(wallet);
      expect(() => wallet[kind](brl("0.00"), movement())).toThrow(InvalidMovementError);
      expect(() => wallet[kind](brl("5.00").negate(), movement())).toThrow(InvalidMovementError);
      expect(snapshot(wallet)).toEqual(before);
    },
  );

  // FR-03
  test.each(["debit", "credit"] as const)("%s refuses another currency, and changes nothing", (kind) => {
    const { wallet } = openWith("100.00");
    const before = snapshot(wallet);
    const usd = Money.from({ amount: "5.00", currency: "USD" });
    expect(() => wallet[kind](usd, movement())).toThrow(CurrencyMismatchError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test("a movement with an unusable id leaves the wallet unchanged, because the entry is built first", () => {
    const { wallet } = openWith("100.00");
    const before = snapshot(wallet);
    expect(() => wallet.debit(brl("10.00"), { transactionId: "", entryId: "e", at: T0 })).toThrow();
    expect(() =>
      wallet.credit(brl("10.00"), { transactionId: "t", entryId: "e", at: new Date("nope") }),
    ).toThrow();
    expect(snapshot(wallet)).toEqual(before);
  });
});

describe("version moves only when the balance does (FR-13)", () => {
  test("refused movements never move it", () => {
    const { wallet } = openWith("10.00");
    for (const attempt of [
      () => wallet.debit(brl("11.00"), movement()),
      () => wallet.debit(brl("0.00"), movement()),
      () => wallet.credit(brl("0.00"), movement()),
      () => wallet.credit(Money.from({ amount: "1.00", currency: "USD" }), movement()),
    ]) {
      expect(attempt).toThrow();
    }
    expect(wallet.version).toBe(1);
  });

  test("each applied movement moves it by exactly one", () => {
    const { wallet } = openWith("10.00");
    wallet.credit(brl("1.00"), movement());
    wallet.debit(brl("2.00"), movement());
    wallet.credit(brl("3.00"), movement());
    expect(wallet.version).toBe(4);
  });
});

describe("balance and ledger agree (FR-14)", () => {
  // The suite-wide invariant from §13, at unit level: balance == balance rebuilt from the ledger.
  test("after a mixed sequence the balance equals what the entries rebuild, link by link", () => {
    const { wallet, openingEntry } = openWith("500.00");
    const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];

    const steps: Array<["debit" | "credit", string]> = [
      ["debit", "80.00"],
      ["debit", "999.00"], // refused
      ["credit", "25.50"],
      ["debit", "0.01"],
      ["credit", "0.10"],
      ["debit", "445.59"],
      ["debit", "0.01"], // refused: the previous step spent the balance down to exactly 0.00
    ];
    for (const [kind, amount] of steps) {
      try {
        entries.push(wallet[kind](brl(amount), movement()));
      } catch {
        // refused movements leave no entry, which is the point
      }
    }

    let rebuilt = Money.zero("BRL");
    for (const entry of entries) {
      rebuilt =
        entry.direction === LedgerDirection.Credit ? rebuilt.add(entry.money) : rebuilt.subtract(entry.money);
    }
    expect(rebuilt.equals(wallet.balance)).toBe(true);

    entries.forEach((entry, index) => {
      expect(entry.isBalanced()).toBe(true);
      const previous = entries[index - 1];
      if (previous) {
        expect(entry.balanceBefore.equals(previous.balanceAfter)).toBe(true);
        expect(entry.walletVersion).toBeGreaterThan(previous.walletVersion);
      }
    });
    expect(entries.at(-1)?.walletVersion).toBe(wallet.version);
  });

  test("with a zero opening there is no entry, and the rebuild still starts from zero", () => {
    const { wallet, openingEntry } = openWith("0.00");
    const credit = wallet.credit(brl("7.00"), movement());
    expect(openingEntry).toBeUndefined();
    expect(credit.balanceBefore.isZero()).toBe(true);
    expect(credit.balanceAfter.equals(wallet.balance)).toBe(true);
  });
});

describe("rehydrate", () => {
  test("restores state without re-validating, then keeps counting from the stored version", () => {
    const wallet = Wallet.rehydrate({
      id: "w9",
      playerId: "p9",
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(wallet.version).toBe(7);
    const entry = wallet.debit(brl("2.00"), movement());
    expect(wallet.version).toBe(8);
    expect(entry.walletVersion).toBe(8);
    expect(entry.balanceBefore.toJSON().amount).toBe("42.00");
  });

  test("a caller's dates neither leak in nor out", () => {
    const at = new Date(T0);
    const { wallet } = Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("0.00"), at });
    at.setFullYear(1999);
    wallet.createdAt.setFullYear(1999);
    wallet.updatedAt.setFullYear(1999);
    expect(wallet.createdAt.toISOString()).toBe(T0.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(T0.toISOString());
  });
});
