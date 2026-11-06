import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerTransactionKind as Kind } from "../../src/wagering/domain/wager-transaction";
import { type RunningApp, startApp } from "../support/app";
import { call, type Reply } from "../support/http";
import { brl, command, SettlementWorld } from "../support/settlement";

// Reconciliation over the real HTTP stack and a real database (FR-70 to FR-72). Divergences are injected through
// SQL, because that is the only way a wallet could ever come to disagree with its ledger.

setDefaultTimeout(30_000);

let world: SettlementWorld;
let app: RunningApp;
beforeAll(async () => {
  world = await SettlementWorld.create();
  app = await startApp(world.databaseUrl(), { roles: "api" });
});
afterAll(async () => {
  await app.stop();
  await world.destroy();
});

const reconcile = (walletId: string): Promise<Reply> =>
  call(`${app.url}/wallets/${walletId}/reconciliation`, { method: "POST" });

async function metric(result: "consistent" | "divergent"): Promise<number> {
  const text = await (await call(`${app.url}/metrics`)).text();
  const line = text
    .split("\n")
    .find((l) => l.startsWith(`wagering_reconciliations_total{result="${result}"}`));
  return Number(line?.split(" ").at(-1));
}

/** Runs `work` with the ledger's append-only trigger off, which only the table's owner can do (T-09). */
async function withLedgerTriggerOff(work: () => Promise<void>) {
  await world.sql("alter table wallet_ledger_entries disable trigger tr_ledger_append_only");
  try {
    await work();
  } finally {
    await world.sql("alter table wallet_ledger_entries enable trigger tr_ledger_append_only");
  }
}

/** A wallet with an opening of 100.00, a bet of 30.00 and a win of 10.00: three entries, balance 80.00. */
async function activeWallet() {
  const wallet = await world.openWallet("100.00");
  await world.useCase.execute(command(wallet, { money: brl("30.00") }));
  await world.useCase.execute(command(wallet, { kind: Kind.Win, money: brl("10.00") }));
  return wallet;
}

describe("a wallet that agrees with its ledger", () => {
  test("answers as the challenge shows, with every entry counted", async () => {
    const wallet = await activeWallet();
    const response = await reconcile(wallet.walletId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId: wallet.walletId,
      storedBalance: { amount: "80.00", currency: "BRL" },
      calculatedBalance: { amount: "80.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 3,
      issueCount: 0,
      issues: [],
    });
  });

  test("a wallet with no entries is consistent at zero", async () => {
    const wallet = await world.openWallet("0.00");
    expect(await (await reconcile(wallet.walletId)).json()).toMatchObject({
      consistent: true,
      checkedEntries: 0,
      storedBalance: { amount: "0.00" },
      calculatedBalance: { amount: "0.00" },
    });
  });

  test("changes nothing, and can be repeated", async () => {
    const wallet = await activeWallet();
    const before = await world.walletState(wallet.walletId);
    const counts = await world.counts(wallet.walletId);
    for (let i = 0; i < 3; i++)
      expect((await (await reconcile(wallet.walletId)).json()).consistent).toBe(true);
    expect(await world.walletState(wallet.walletId)).toEqual(before);
    expect(await world.counts(wallet.walletId)).toEqual(counts);
  });
});

describe("a divergence injected through SQL (FR-72)", () => {
  test.each([
    ["more than the ledger explains", "+ 2.00", "2.00"],
    ["less than the ledger explains", "- 5.00", "-5.00"],
  ])(
    "a wallet holding %s is flagged with a signed difference, logged, counted, and left alone",
    async (_name, change, difference) => {
      const wallet = await activeWallet();
      await world.sql(`update wallets set balance = balance ${change} where id = ?`, [wallet.walletId]);
      const stored = (await world.walletState(wallet.walletId)).balance;
      const divergentBefore = await metric("divergent");
      app.logs.length = 0;

      const response = await reconcile(wallet.walletId);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        consistent: false,
        difference: { amount: difference, currency: "BRL" },
        calculatedBalance: { amount: "80.00" },
        issueCount: 0,
      });

      const logged = app.logs.filter((line) => line.level === "error" && line.walletId === wallet.walletId);
      expect(logged).toHaveLength(1);
      expect(String(logged[0]?.message)).toContain(`difference ${difference} BRL`);
      expect(await metric("divergent")).toBe(divergentBefore + 1);

      // Nothing corrected: not the balance, not the ledger, not on the second look either.
      expect((await world.walletState(wallet.walletId)).balance).toBe(stored);
      // Two: the count leaves the opening out, as the entry count of a bet and a win.
      expect((await world.counts(wallet.walletId)).entries).toBe(2);
      expect((await (await reconcile(wallet.walletId)).json()).consistent).toBe(false);
      expect(await metric("divergent")).toBe(divergentBefore + 2);
    },
  );

  test("a consistent check is counted as consistent and logs no error", async () => {
    const wallet = await activeWallet();
    const before = await metric("consistent");
    app.logs.length = 0;
    await reconcile(wallet.walletId);
    expect(await metric("consistent")).toBe(before + 1);
    expect(app.logs.filter((line) => line.level === "error")).toEqual([]);
  });

  test("an entry that does not add up is named, though the balance still matches", async () => {
    const wallet = await activeWallet();
    // The schema refuses such a row (ck_ledger_arithmetic), which is the first defence. This takes that one away too,
    // to see that the check would notice if both failed.
    const rows = await world.sql(
      "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'ck_ledger_arithmetic'",
    );
    const definition = rows[0]?.definition as string;
    const setVersion2After = (balance: string) =>
      world.sql(
        "update wallet_ledger_entries set balance_after = ? where wallet_id = ? and wallet_version = 2",
        [balance, wallet.walletId],
      );

    await world.sql("alter table wallet_ledger_entries disable trigger tr_ledger_append_only");
    await world.sql("alter table wallet_ledger_entries drop constraint ck_ledger_arithmetic");
    try {
      // Version 2 is the bet: 100.00 - 30.00 = 70.00. Claim it left 71.00, and the next entry then does not chain.
      await setVersion2After("71.00");
      const body = await (await reconcile(wallet.walletId)).json();
      expect(body.difference.amount).toBe("0.00");
      expect(body.consistent).toBe(false);
      expect(body.issues).toEqual([
        { walletVersion: 2, kind: "ENTRY_UNBALANCED" },
        { walletVersion: 3, kind: "CHAIN_BROKEN" },
      ]);
      expect(body.issueCount).toBe(2);
    } finally {
      await setVersion2After("70.00");
      await world.sql(`alter table wallet_ledger_entries add constraint ck_ledger_arithmetic ${definition}`);
      await world.sql("alter table wallet_ledger_entries enable trigger tr_ledger_append_only");
    }
  });

  test("an entry that does not continue the one before is a broken chain", async () => {
    const wallet = await activeWallet();
    await withLedgerTriggerOff(async () => {
      // Version 3 is the win: 70.00 + 10.00 = 80.00. Shift the whole entry so it adds up but starts elsewhere.
      await world.sql(
        "update wallet_ledger_entries set balance_before = 75.00, balance_after = 85.00 where wallet_id = ? and wallet_version = 3",
        [wallet.walletId],
      );
      const body = await (await reconcile(wallet.walletId)).json();
      expect(body.issues).toEqual([{ walletVersion: 3, kind: "CHAIN_BROKEN" }]);
      expect(body.consistent).toBe(false);
    });
  });

  test("a first entry that does not start from zero is a broken chain", async () => {
    const wallet = await activeWallet();
    await withLedgerTriggerOff(async () => {
      await world.sql(
        "update wallet_ledger_entries set balance_before = 5.00, balance_after = 105.00 where wallet_id = ? and wallet_version = 1",
        [wallet.walletId],
      );
      const body = await (await reconcile(wallet.walletId)).json();
      expect(body.issues[0]).toEqual({ walletVersion: 1, kind: "CHAIN_BROKEN" });
    });
  });

  test("a deleted entry shows as a difference and a broken chain", async () => {
    const wallet = await activeWallet();
    await withLedgerTriggerOff(async () => {
      await world.sql("delete from wallet_ledger_entries where wallet_id = ? and wallet_version = 2", [
        wallet.walletId,
      ]);
      const body = await (await reconcile(wallet.walletId)).json();
      expect(body.checkedEntries).toBe(2);
      expect(body.difference.amount).toBe("-30.00");
      expect(body.issues).toEqual([{ walletVersion: 3, kind: "CHAIN_BROKEN" }]);
    });
  });

  test("names at most twenty entries and still counts them all", async () => {
    const wallet = await world.openWallet("100.00");
    for (let i = 0; i < 25; i++) await world.useCase.execute(command(wallet, { money: brl("1.00") }));
    await withLedgerTriggerOff(async () => {
      await world.sql(
        "update wallet_ledger_entries set balance_before = balance_before + wallet_version, balance_after = balance_after + wallet_version where wallet_id = ? and wallet_version > 1",
        [wallet.walletId],
      );
      const body = await (await reconcile(wallet.walletId)).json();
      expect(body.checkedEntries).toBe(26);
      expect(body.issueCount).toBe(25);
      expect(body.issues).toHaveLength(20);
    });
  });
});

describe("reading takes no lock (FR-71)", () => {
  test("a wallet whose lock is held is reconciled at once", async () => {
    const wallet = await activeWallet();
    const release = await world.holdLock(wallet.walletId);
    try {
      const started = performance.now();
      const response = await reconcile(wallet.walletId);
      expect(response.status).toBe(200);
      expect((await response.json()).consistent).toBe(true);
      // The lock timeout is 2 s: a read that waited for it would take that long or fail.
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      await release();
    }
  });

  test("a snapshot is whole: reconciling while bets commit never shows a torn wallet", async () => {
    const wallet = await world.openWallet("1000.00");
    const bets = Promise.all(
      Array.from({ length: 80 }, () => world.useCase.execute(command(wallet, { money: brl("1.00") }))),
    );
    const checks: Reply[] = [];
    while (checks.length < 60) checks.push(await reconcile(wallet.walletId));
    await bets;

    // A balance read in one statement and the ledger in another would disagree whenever a bet committed between.
    const bodies = await Promise.all(checks.map((response) => response.json()));
    expect(bodies.every((body) => body.consistent === true)).toBe(true);
    expect(new Set(bodies.map((body) => body.checkedEntries)).size).toBeGreaterThan(1);
    expect((await (await reconcile(wallet.walletId)).json()).checkedEntries).toBe(81);
  });
});

describe("what is refused", () => {
  test("a wallet that does not exist is a 404 in the error envelope", async () => {
    const response = await reconcile(randomUUID());
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("WALLET_NOT_FOUND");
  });

  test("an id that is not a UUID is a 400 that names it", async () => {
    const response = await reconcile("not-a-uuid");
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
