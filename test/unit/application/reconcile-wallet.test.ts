import { describe, expect, test } from "bun:test";
import { TransientFailureError, WalletNotFoundError } from "../../../src/wagering/application/errors";
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

describe("how many run at once is bounded (FR-102)", () => {
  /** A reader whose snapshots stay open until the test lets them finish, or fail. */
  function held(maxConcurrent: number) {
    const open: Array<{ finish: () => void; fail: () => void }> = [];
    const reader: ReconciliationReader = {
      snapshot: () =>
        new Promise((resolve, reject) => {
          open.push({
            finish: () =>
              resolve({
                storedBalance: brl("0.00"),
                credits: brl("0.00"),
                debits: brl("0.00"),
                checkedEntries: 0,
                issueCount: 0,
                issues: [],
              }),
            fail: () => reject(new Error("the read failed")),
          });
        }),
    };
    const useCase = new ReconcileWallet(reader, { checked: () => undefined }, maxConcurrent);
    return { run: () => useCase.execute("wallet-1"), open };
  }

  test("one over the bound is refused at once as transient, and the ones running are untouched", async () => {
    const { run, open } = held(2);
    const first = run();
    const second = run();
    // Raced against a timer: without the bound the third call would wait for the reader for ever.
    const third = await Promise.race([
      run().catch((error: unknown) => error),
      Bun.sleep(200).then(() => "waited"),
    ]);
    expect(third).toBeInstanceOf(TransientFailureError);
    expect(open).toHaveLength(2); // the refused one never reached the reader
    for (const read of open) read.finish();
    expect((await first).consistent).toBe(true);
    expect((await second).consistent).toBe(true);
  });

  test("a finished one frees its place", async () => {
    const { run, open } = held(1);
    const first = run();
    open[0]?.finish();
    await first;
    const next = run();
    open[1]?.finish();
    expect((await next).consistent).toBe(true);
  });

  test("a failed one frees its place too, or a few errors would close the endpoint for good", async () => {
    const { run, open } = held(1);
    const first = run();
    open[0]?.fail();
    await expect(first).rejects.toThrow("the read failed");
    const next = run();
    open[1]?.finish();
    expect((await next).consistent).toBe(true);
  });
});
