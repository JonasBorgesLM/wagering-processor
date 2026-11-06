import { describe, expect, test } from "bun:test";
import { WalletNotFoundError } from "../../../src/wagering/application/errors";
import type {
  LedgerSnapshot,
  ReconciliationReader,
  ReconciliationReport,
} from "../../../src/wagering/application/ports";
import { ReconcileWallet } from "../../../src/wagering/application/reconcile-wallet";
import { Money } from "../../../src/wagering/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

function reconcile(snapshot: Partial<LedgerSnapshot> | undefined) {
  const reported: ReconciliationReport[] = [];
  const reader: ReconciliationReader = {
    snapshot: async () =>
      snapshot && {
        storedBalance: brl("0.00"),
        credits: brl("0.00"),
        debits: brl("0.00"),
        checkedEntries: 0,
        issueCount: 0,
        issues: [],
        ...snapshot,
      },
  };
  const useCase = new ReconcileWallet(reader, { checked: (report) => reported.push(report) });
  return { run: () => useCase.execute("wallet-1"), reported };
}

describe("what a ledger adds up to (FR-70)", () => {
  test("credits minus debits, compared with the stored balance", async () => {
    const { run } = reconcile({
      storedBalance: brl("975.00"),
      credits: brl("1000.00"),
      debits: brl("25.00"),
      checkedEntries: 2,
    });
    const report = await run();
    expect(report.calculatedBalance.toJSON()).toEqual({ amount: "975.00", currency: "BRL" });
    expect(report.difference.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(report.consistent).toBe(true);
    expect(report.checkedEntries).toBe(2);
  });

  test("the difference is signed: stored minus calculated (FR-72)", async () => {
    const more = await reconcile({ storedBalance: brl("102.00"), credits: brl("100.00") }).run();
    expect(more.difference.toJSON().amount).toBe("2.00");
    const less = await reconcile({ storedBalance: brl("95.00"), credits: brl("100.00") }).run();
    expect(less.difference.toJSON().amount).toBe("-5.00");
    expect([more.consistent, less.consistent]).toEqual([false, false]);
  });

  test("a ledger that debits more than it credits is a negative calculated balance, not an error", async () => {
    const report = await reconcile({
      storedBalance: brl("0.00"),
      credits: brl("10.00"),
      debits: brl("15.00"),
    }).run();
    expect(report.calculatedBalance.toJSON().amount).toBe("-5.00");
    expect(report.difference.toJSON().amount).toBe("5.00");
    expect(report.consistent).toBe(false);
  });

  test("a balance that adds up is still inconsistent when an entry does not chain", async () => {
    const report = await reconcile({
      storedBalance: brl("50.00"),
      credits: brl("50.00"),
      issueCount: 1,
      issues: [{ walletVersion: 3, kind: "CHAIN_BROKEN" }],
    }).run();
    expect(report.difference.isZero()).toBe(true);
    expect(report.consistent).toBe(false);
  });

  test("an empty ledger and a zero balance are consistent", async () => {
    expect((await reconcile({}).run()).consistent).toBe(true);
  });
});

describe("making it visible, and only that", () => {
  test("every check is reported once, consistent or not", async () => {
    const { run, reported } = reconcile({ storedBalance: brl("1.00") });
    const report = await run();
    expect(reported).toEqual([report]);
  });

  test("a wallet that does not exist is not reported", async () => {
    const { run, reported } = reconcile(undefined);
    await expect(run()).rejects.toThrow(WalletNotFoundError);
    expect(reported).toEqual([]);
  });
});
