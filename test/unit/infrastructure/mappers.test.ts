import { describe, expect, test } from "bun:test";
import { InvalidMoneyError } from "../../../src/wagering/domain/errors";
import { INFRASTRUCTURE_FAILURE_CODES, REJECTION_CODES } from "../../../src/wagering/domain/failure-code";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  WagerTransaction,
} from "../../../src/wagering/domain/wager-transaction";
import { Wallet } from "../../../src/wagering/domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../../src/wagering/domain/wallet-ledger-entry";
import {
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  PersistenceMappingError,
  transactionFromRecord,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from "../../../src/wagering/infrastructure/persistence/mappers";
import type {
  LedgerEntryRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "../../../src/wagering/infrastructure/persistence/records";
import { brl, T0, transaction, walletWith } from "../../support/domain-fixtures";

// No database here: what a mapper does with values it should never see, and what it promises about itself.
// The round trip through PostgreSQL is in test/integration/persistence.test.ts.

const walletRecord = (overrides: Partial<WalletRecord> = {}): WalletRecord => ({
  ...walletToRecord(walletWith("100.00")),
  ...overrides,
});

const transactionRecord = (overrides: Partial<WagerTransactionRecord> = {}): WagerTransactionRecord => {
  const t = transaction(Kind.Bet);
  t.markProcessed(undefined, brl("75.00"), T0);
  return { ...transactionToRecord(t, T0), ...overrides };
};

const entryRecord = (overrides: Partial<LedgerEntryRecord> = {}): LedgerEntryRecord => {
  const wallet = walletWith("100.00");
  const entry = wallet.debit(brl("25.00"), { transactionId: "t1", entryId: "e1", at: T0 });
  return { ...ledgerEntryToRecord(entry), ...overrides };
};

describe("a stored value the code does not recognise fails loudly", () => {
  test.each([
    ["kind", { kind: "SIDEWAYS" }],
    ["status", { status: "DONE" }],
    ["failureCode", { failureCode: "NOPE" }],
  ] as const)("a transaction with an unknown %s", (field, override) => {
    expect(() => transactionFromRecord(transactionRecord(override))).toThrow(PersistenceMappingError);
    expect(() => transactionFromRecord(transactionRecord(override))).toThrow(new RegExp(`unknown ${field}`));
  });

  test("a ledger entry with an unknown direction", () => {
    expect(() => ledgerEntryFromRecord(entryRecord({ direction: "SIDEWAYS" }))).toThrow(/unknown direction/);
  });

  // The other direction of the same guarantee: nothing the code knows is refused.
  test.each(Object.values(Kind))("kind %s maps", (kind) => {
    expect(transactionFromRecord(transactionRecord({ kind })).kind).toBe(kind);
  });
  test.each(Object.values(Status))("status %s maps", (status) => {
    expect(transactionFromRecord(transactionRecord({ status })).status).toBe(status);
  });
  test.each([...REJECTION_CODES, ...INFRASTRUCTURE_FAILURE_CODES])("failure code %s maps", (failureCode) => {
    expect(transactionFromRecord(transactionRecord({ failureCode })).failureCode).toBe(failureCode);
  });
  test.each(Object.values(LedgerDirection))("direction %s maps", (direction) => {
    expect(ledgerEntryFromRecord(entryRecord({ direction })).direction).toBe(direction);
  });
});

describe("a corrupt amount or currency is refused, never repaired", () => {
  // The column is numeric(20,2), so none of these can be stored. If one arrives, silently fixing it would hide the drift.
  const bad = ["abc", "25", "25.5", "1.005", "-1.00", "", "1e3"];

  test.each(bad)("wallet balance %p", (balance) => {
    expect(() => walletFromRecord(walletRecord({ balance }))).toThrow(InvalidMoneyError);
  });

  test.each(bad)("transaction amount %p", (amount) => {
    expect(() => transactionFromRecord(transactionRecord({ amount }))).toThrow(InvalidMoneyError);
  });

  test.each(bad)("observed balance %p", (observedBalance) => {
    expect(() => transactionFromRecord(transactionRecord({ observedBalance }))).toThrow(InvalidMoneyError);
  });

  test.each(["amount", "balanceBefore", "balanceAfter"] as const)("ledger %s", (field) => {
    expect(() => ledgerEntryFromRecord(entryRecord({ [field]: "1.005" }))).toThrow(InvalidMoneyError);
  });

  test.each(["br", "BRLX", "", "R$"])("currency %p", (currency) => {
    expect(() => walletFromRecord(walletRecord({ currency }))).toThrow(InvalidMoneyError);
    expect(() => transactionFromRecord(transactionRecord({ currency }))).toThrow(InvalidMoneyError);
    expect(() => ledgerEntryFromRecord(entryRecord({ currency }))).toThrow(InvalidMoneyError);
  });
});

describe("absent values", () => {
  test("an optional field that is absent is stored as null, never left undefined", () => {
    const record = transactionToRecord(transaction(Kind.Bet), T0);
    expect(record.referenceExternalTransactionId).toBeNull();
    expect(record.referenceTransactionId).toBeNull();
    expect(record.failureCode).toBeNull();
    expect(record.observedBalance).toBeNull();
    expect(record.processedAt).toBeNull();
  });

  // The ORM gives null for a NULL column, and undefined for a column that was not loaded. Both mean absent.
  test.each([null, undefined])("%p reads back as absent", (absent) => {
    const t = transactionFromRecord(
      transactionRecord({
        referenceExternalTransactionId: absent as null,
        referenceTransactionId: absent as null,
        failureCode: absent as null,
        observedBalance: absent as null,
        processedAt: absent as null,
      }),
    );
    expect(t.referenceExternalTransactionId).toBeUndefined();
    expect(t.referenceTransactionId).toBeUndefined();
    expect(t.failureCode).toBeUndefined();
    expect(t.observedBalance).toBeUndefined();
    expect(t.processedAt).toBeUndefined();
  });

  test("a present value is kept, including a balance of zero", () => {
    const t = transactionFromRecord(transactionRecord({ observedBalance: "0.00" }));
    expect(t.observedBalance?.isZero()).toBe(true);
  });

  test("a balance in the row's currency, not a default one", () => {
    const t = transactionFromRecord(
      transactionRecord({ currency: "USD", amount: "5.00", observedBalance: "9.00" }),
    );
    expect(t.observedBalance?.toString()).toBe("9.00 USD");
  });
});

describe("what a mapper promises about itself", () => {
  test("it returns domain classes, not records", () => {
    expect(walletFromRecord(walletRecord())).toBeInstanceOf(Wallet);
    expect(transactionFromRecord(transactionRecord())).toBeInstanceOf(WagerTransaction);
    expect(ledgerEntryFromRecord(entryRecord())).toBeInstanceOf(WalletLedgerEntry);
  });

  test("changing the record afterwards does not reach the domain object", () => {
    const record = walletRecord();
    const wallet = walletFromRecord(record);
    record.balance = "1.00";
    record.version = 99;
    record.createdAt.setFullYear(1999);
    expect(wallet.balance.toString()).toBe("100.00 BRL");
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt.getFullYear()).toBe(2026);
  });

  test("changing a record made from a domain object does not reach it either", () => {
    const wallet = walletWith("100.00");
    const record = walletToRecord(wallet);
    record.createdAt.setFullYear(1999);
    record.updatedAt.setFullYear(1999);
    expect(wallet.createdAt.getFullYear()).toBe(2026);
    expect(wallet.updatedAt.getFullYear()).toBe(2026);
  });

  test("mapping to a record twice gives the same record and leaves the object alone", () => {
    const wallet = walletWith("100.00");
    expect(walletToRecord(wallet)).toStrictEqual(walletToRecord(wallet));
    expect(wallet.balance.toString()).toBe("100.00 BRL");
    const t = transaction(Kind.Bet);
    expect(transactionToRecord(t, T0)).toStrictEqual(transactionToRecord(t, T0));
    expect(t.status).toBe(Status.Pending);
  });

  test("the audit column is the one the caller gives, and the domain has no say", () => {
    const later = new Date("2030-01-01T00:00:00.000Z");
    expect(transactionToRecord(transaction(Kind.Bet), later).updatedAt.toISOString()).toBe(
      later.toISOString(),
    );
  });

  test("the record has no domain behaviour to call: it is plain data", () => {
    for (const record of [walletRecord(), transactionRecord(), entryRecord()]) {
      for (const value of Object.values(record)) expect(typeof value).not.toBe("function");
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    }
  });

  test("amounts are strings in every record, never numbers", () => {
    const wallet = walletToRecord(walletWith("100.00"));
    expect(typeof wallet.balance).toBe("string");
    const t = transactionRecord();
    expect(typeof t.amount).toBe("string");
    expect(typeof t.observedBalance).toBe("string");
    const e = entryRecord();
    for (const field of [e.amount, e.balanceBefore, e.balanceAfter]) expect(typeof field).toBe("string");
  });
});

describe("a stored entry that does not add up still loads, so reconciliation can report it (FR-70)", () => {
  test("the arithmetic is not re-validated on the way in", () => {
    const entry = ledgerEntryFromRecord(entryRecord({ balanceAfter: "999.00" }));
    expect(entry.isBalanced()).toBe(false);
  });
});
