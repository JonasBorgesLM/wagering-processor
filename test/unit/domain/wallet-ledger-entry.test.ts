import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidLedgerEntryError } from "../../../src/wagering/domain/errors";
import { Money } from "../../../src/wagering/domain/money";
import {
  type CreateLedgerEntryProps,
  LedgerDirection,
  WalletLedgerEntry,
} from "../../../src/wagering/domain/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

const credit = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: "e1",
  walletId: "w1",
  transactionId: "t1",
  direction: LedgerDirection.Credit,
  money: brl("25.00"),
  balanceBefore: brl("100.00"),
  balanceAfter: brl("125.00"),
  walletVersion: 2,
  createdAt: new Date("2026-11-05T12:00:00.000Z"),
  ...overrides,
});

const debit = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps =>
  credit({
    direction: LedgerDirection.Debit,
    balanceBefore: brl("100.00"),
    balanceAfter: brl("75.00"),
    ...overrides,
  });

describe("WalletLedgerEntry.create", () => {
  test("accepts a balanced credit", () => {
    const entry = WalletLedgerEntry.create(credit());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test("accepts a balanced debit that empties the wallet", () => {
    const entry = WalletLedgerEntry.create(
      debit({ money: brl("100.00"), balanceBefore: brl("100.00"), balanceAfter: brl("0.00") }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  // §6.4: the arithmetic is checked at creation, so an entry that does not add up cannot exist.
  test.each([
    ["a credit that adds too little", credit({ balanceAfter: brl("124.99") })],
    ["a credit that adds too much", credit({ balanceAfter: brl("125.01") })],
    ["a debit that subtracts too little", debit({ balanceAfter: brl("75.01") })],
    ["a debit that subtracts too much", debit({ balanceAfter: brl("74.99") })],
    ["a credit recorded as a debit", credit({ direction: LedgerDirection.Debit })],
    ["a debit recorded as a credit", debit({ direction: LedgerDirection.Credit })],
    ["a balance that did not move", credit({ balanceAfter: brl("100.00") })],
  ])("rejects %s", (_name, props) => {
    expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a zero amount, because an entry with no movement is noise in the audit trail", () => {
    expect(() =>
      WalletLedgerEntry.create(credit({ money: brl("0.00"), balanceAfter: brl("100.00") })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a negative amount", () => {
    expect(() =>
      WalletLedgerEntry.create(credit({ money: brl("25.00").negate(), balanceAfter: brl("75.00") })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a negative balance on either side", () => {
    expect(() =>
      WalletLedgerEntry.create(
        debit({ balanceBefore: brl("10.00"), balanceAfter: brl("10.00").subtract(brl("25.00")) }),
      ),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(credit({ balanceBefore: brl("10.00").negate(), balanceAfter: brl("15.00") })),
    ).toThrow(InvalidLedgerEntryError);
  });

  // FR-03
  test("rejects mixed currencies", () => {
    const usd = Money.from({ amount: "125.00", currency: "USD" });
    expect(() => WalletLedgerEntry.create(credit({ balanceAfter: usd }))).toThrow(CurrencyMismatchError);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects walletVersion %p",
    (walletVersion) => {
      expect(() => WalletLedgerEntry.create(credit({ walletVersion }))).toThrow(InvalidLedgerEntryError);
    },
  );

  test.each(["id", "walletId", "transactionId"] as const)("rejects an empty %s", (field) => {
    expect(() => WalletLedgerEntry.create(credit({ [field]: "  " }))).toThrow(InvalidLedgerEntryError);
  });

  test("rejects an invalid date and an unknown direction", () => {
    expect(() => WalletLedgerEntry.create(credit({ createdAt: new Date("nope") }))).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create(credit({ direction: "SIDEWAYS" as LedgerDirection }))).toThrow(
      InvalidLedgerEntryError,
    );
  });
});

describe("immutability", () => {
  const writable = (entry: WalletLedgerEntry) => entry as unknown as Record<string, unknown>;

  // §6.4: structural, not a convention.
  test("every field refuses assignment", () => {
    const entry = WalletLedgerEntry.create(credit());
    for (const field of ["id", "direction", "money", "balanceAfter", "walletVersion"]) {
      expect(() => {
        writable(entry)[field] = "tampered";
      }).toThrow(TypeError);
    }
    expect(entry.walletVersion).toBe(2);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  test("offers no way to change state", () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (name) => name !== "constructor",
    );
    expect(methods.sort()).toEqual(["createdAt", "isBalanced"]);
  });

  test("a caller's date neither leaks in nor out", () => {
    const at = new Date("2026-11-05T12:00:00.000Z");
    const entry = WalletLedgerEntry.create(credit({ createdAt: at }));
    at.setFullYear(1999);
    entry.createdAt.setFullYear(1999);
    expect(entry.createdAt.toISOString()).toBe("2026-11-05T12:00:00.000Z");
  });
});

describe("rehydrate", () => {
  // Reconciliation (FR-70) depends on this: it must be able to load a bad row to report it.
  test("does not re-validate, so a corrupt stored entry is loadable and reports itself unbalanced", () => {
    const corrupt = WalletLedgerEntry.rehydrate(credit({ balanceAfter: brl("999.00") }));
    expect(corrupt.isBalanced()).toBe(false);
  });

  // Whatever the database holds must be loadable, or reconciliation could not report it.
  test("loads even what create would refuse: a zero amount and a negative stored balance", () => {
    const zeroAmount = WalletLedgerEntry.rehydrate(
      credit({ money: brl("0.00"), balanceAfter: brl("100.00") }),
    );
    const negativeBalance = WalletLedgerEntry.rehydrate(debit({ balanceAfter: brl("5.00").negate() }));
    expect(zeroAmount.money.isZero()).toBe(true);
    expect(negativeBalance.balanceAfter.isNegative()).toBe(true);
    expect(negativeBalance.isBalanced()).toBe(false);
  });

  test("reports mixed currencies as unbalanced instead of throwing", () => {
    const usd = Money.from({ amount: "125.00", currency: "USD" });
    expect(WalletLedgerEntry.rehydrate(credit({ balanceAfter: usd })).isBalanced()).toBe(false);
  });

  test("restores what create produced", () => {
    const created = WalletLedgerEntry.create(debit());
    const restored = WalletLedgerEntry.rehydrate({
      id: created.id,
      walletId: created.walletId,
      transactionId: created.transactionId,
      direction: created.direction,
      money: created.money,
      balanceBefore: created.balanceBefore,
      balanceAfter: created.balanceAfter,
      walletVersion: created.walletVersion,
      createdAt: created.createdAt,
    });
    expect(restored.isBalanced()).toBe(true);
    expect(restored.balanceAfter.toJSON().amount).toBe("75.00");
  });
});
