import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../src/platform/database/mikro-orm.config";
import {
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../src/wagering/application/errors";
import { OpenWallet } from "../../src/wagering/application/open-wallet";
import { QueryWallets } from "../../src/wagering/application/query-wallets";
import { Money } from "../../src/wagering/domain/money";
import { WagerTransactionKind as Kind } from "../../src/wagering/domain/wager-transaction";
import { MikroOrmWalletReader } from "../../src/wagering/infrastructure/persistence/mikro-orm-wallet-reader";
import { wageringEntitySchemas } from "../../src/wagering/infrastructure/persistence/schemas";
import { brl, command, deferred, instrumented, SettlementWorld } from "../support/settlement";

let world: SettlementWorld;
beforeAll(async () => {
  world = await SettlementWorld.create();
});
afterAll(() => world.destroy());

const open = (balance: string, playerId = randomUUID(), currency = "BRL") =>
  world.wallets.execute({
    playerId,
    initialBalance: Money.from({ amount: balance, currency }),
    correlationId: randomUUID(),
  });

const everything = async (walletId: string) => {
  const rows = await world.sql(
    `select
       (select count(*)::int from wallets where id = ?) as wallets,
       (select count(*)::int from wager_transactions where wallet_id = ?) as transactions,
       (select count(*)::int from wallet_ledger_entries where wallet_id = ?) as entries,
       (select count(*)::int from outbox_messages where aggregate_id = ?) as events`,
    [walletId, walletId, walletId, walletId],
  );
  return rows[0] as { wallets: number; transactions: number; entries: number; events: number };
};

describe("opening a wallet", () => {
  test("a positive balance is funded by an OPENING, an entry and two events, together (FR-11)", async () => {
    const wallet = await open("1000.00");
    expect(wallet).toMatchObject({ version: 1 });
    expect(wallet.balance.toString()).toBe("1000.00 BRL");
    expect(await everything(wallet.id)).toEqual({ wallets: 1, transactions: 1, entries: 1, events: 2 });

    const [opening] = await world.sql(
      "select kind, provider_id, status, amount::text as amount, observed_balance::text as balance from wager_transactions where wallet_id = ?",
      [wallet.id],
    );
    expect(opening).toEqual({
      kind: "OPENING",
      provider_id: "internal",
      status: "PROCESSED",
      amount: "1000.00",
      balance: "1000.00",
    });
    const [entry] = await world.sql(
      "select direction, balance_before::text as before, balance_after::text as after, wallet_version from wallet_ledger_entries where wallet_id = ?",
      [wallet.id],
    );
    expect(entry).toEqual({ direction: "CREDIT", before: "0.00", after: "1000.00", wallet_version: 1 });

    const types = await world.sql(
      "select event_type from outbox_messages where aggregate_id = ? order by event_type",
      [wallet.id],
    );
    expect(types.map((row) => row.event_type)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    await world.expectLedgerExplainsBalance(wallet.id);
  });

  // The failure mode on the issue: the opening must not make this version 2.
  test("the version stays at 1, and the first real movement is version 2", async () => {
    const wallet = await open("100.00");
    expect((await world.walletState(wallet.id)).version).toBe(1);
    await world.useCase.execute(
      command({ walletId: wallet.id, playerId: wallet.playerId }, { money: brl("30.00") }),
    );
    expect(await world.walletState(wallet.id)).toEqual({ balance: "70.00", version: 2 });
    await world.expectLedgerExplainsBalance(wallet.id);
  });

  test("a zero balance creates a wallet and nothing else (FR-12)", async () => {
    const wallet = await open("0.00");
    expect(wallet).toMatchObject({ version: 1 });
    expect(wallet.balance.isZero()).toBe(true);
    expect(await everything(wallet.id)).toEqual({ wallets: 1, transactions: 0, entries: 0, events: 0 });
    await world.expectLedgerExplainsBalance(wallet.id);
  });

  test("the event ids and correlation id are carried into the outbox", async () => {
    const correlationId = "request-42";
    const wallet = await world.wallets.execute({
      playerId: randomUUID(),
      initialBalance: brl("5.00"),
      correlationId,
    });
    const rows = await world.sql("select payload from outbox_messages where aggregate_id = ?", [wallet.id]);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.payload.correlationId).toBe(correlationId);
  });
});

describe("one wallet per player and currency (FR-10)", () => {
  test("a second is a conflict, and the first is untouched", async () => {
    const playerId = randomUUID();
    const first = await open("100.00", playerId);
    await expect(open("999.00", playerId)).rejects.toThrow(WalletAlreadyExistsError);
    const rows = await world.sql("select id, balance::text as balance from wallets where player_id = ?", [
      playerId,
    ]);
    expect(rows).toEqual([{ id: first.id, balance: "100.00" }]);
  });

  test("the refused attempt leaves nothing behind: no transaction, entry or event", async () => {
    const playerId = randomUUID();
    await open("100.00", playerId);
    const before = (
      await world.sql(
        "select (select count(*)::int from wager_transactions) as t, (select count(*)::int from wallet_ledger_entries) as e, (select count(*)::int from outbox_messages) as o",
      )
    )[0];
    await expect(open("500.00", playerId)).rejects.toThrow(WalletAlreadyExistsError);
    const after = (
      await world.sql(
        "select (select count(*)::int from wager_transactions) as t, (select count(*)::int from wallet_ledger_entries) as e, (select count(*)::int from outbox_messages) as o",
      )
    )[0];
    expect(after).toEqual(before);
  });

  test("a zero wallet blocks a second too: the key is the player and currency, not the balance", async () => {
    const playerId = randomUUID();
    await open("0.00", playerId);
    await expect(open("100.00", playerId)).rejects.toThrow(WalletAlreadyExistsError);
  });

  test("another currency is another wallet", async () => {
    const playerId = randomUUID();
    const brlWallet = await open("100.00", playerId, "BRL");
    const usdWallet = await open("10.00", playerId, "USD");
    expect(usdWallet.id).not.toBe(brlWallet.id);
    expect(usdWallet.balance.currency).toBe("USD");
  });
});

describe("creation is atomic (NFR-04)", () => {
  class Crash extends Error {}
  // The wallet is written first, so a crash after any later write must take the wallet down with it.
  test.each(["wallets.insert", "transactions.insert", "ledger.append", "outbox.enqueue"])(
    "a crash right after %s leaves nothing",
    async (write) => {
      const playerId = randomUUID();
      const failing = new OpenWallet(
        instrumented(world.unitOfWork, (call, phase) => {
          if (call === write && phase === "after") throw new Crash();
        }),
        world.clock,
        world.ids,
      );
      await expect(
        failing.execute({ playerId, initialBalance: brl("100.00"), correlationId: "c" }),
      ).rejects.toThrow(Crash);
      expect(
        await world.sql("select count(*)::int as n from wallets where player_id = ?", [playerId]),
      ).toEqual([{ n: 0 }]);

      // And the same request then succeeds: the failure left nothing in its way.
      const wallet = await open("100.00", playerId);
      expect(await everything(wallet.id)).toEqual({ wallets: 1, transactions: 1, entries: 1, events: 2 });
      await world.expectLedgerExplainsBalance(wallet.id);
    },
  );
});

describe("creating the same wallet at once", () => {
  test("20 in parallel give one wallet and 19 conflicts, with one opening and one entry", async () => {
    const playerId = randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => open("100.00", playerId)));
    const created = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(19);
    for (const failure of refused) expect(failure.reason).toBeInstanceOf(WalletAlreadyExistsError);

    const stored = await world.sql("select id from wallets where player_id = ?", [playerId]);
    expect(stored).toHaveLength(1);
    const id = stored[0]?.id as string;
    expect(await everything(id)).toEqual({ wallets: 1, transactions: 1, entries: 1, events: 2 });
    expect(
      (
        await world.sql(
          "select count(*)::int as n from wager_transactions where kind = 'OPENING' and player_id = ?",
          [playerId],
        )
      )[0]?.n,
    ).toBe(1);
    await world.expectLedgerExplainsBalance(id);
  });

  test("different players in parallel do not interfere", async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, () => open("50.00")));
    expect(new Set(wallets.map((w) => w.id)).size).toBe(15);
    for (const wallet of wallets) await world.expectLedgerExplainsBalance(wallet.id);
  });
});

describe("reading a wallet", () => {
  test("returns what is committed", async () => {
    const wallet = await open("100.00");
    await world.useCase.execute(
      command({ walletId: wallet.id, playerId: wallet.playerId }, { money: brl("40.00") }),
    );
    const view = await world.queries.getWallet(wallet.id);
    expect(view.balance.toString()).toBe("60.00 BRL");
    expect(view.version).toBe(2);
  });

  test("a wallet that does not exist", async () => {
    await expect(world.queries.getWallet(randomUUID())).rejects.toThrow(WalletNotFoundError);
  });

  // Reading must never wait on a settlement: a busy wallet would otherwise be unreadable exactly when it matters.
  test("takes no lock: a locked wallet can still be read", async () => {
    const wallet = await open("100.00");
    const held = deferred();
    const release = deferred();
    const holder = world.unitOfWork.run(async (tx) => {
      await tx.wallets.lockById(wallet.id);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const reader = new QueryWallets(
      new MikroOrmWalletReader(world.orm, { lockTimeoutMs: 100, statementTimeoutMs: 1_000 }),
    );
    const view = await reader.getWallet(wallet.id);
    const page = await reader.getLedger(wallet.id, {});
    release.resolve();
    await holder;
    expect(view.balance.toString()).toBe("100.00 BRL");
    expect(page.entries).toHaveLength(1);
  });

  test("an unreachable database is transient, not an error in the request", async () => {
    const orm = await MikroORM.init(createOrmConfig("postgres://wagering:wagering@localhost:1/wagering"));
    const reader = new QueryWallets(
      new MikroOrmWalletReader(orm, { lockTimeoutMs: 100, statementTimeoutMs: 100 }),
    );
    await expect(reader.getWallet(randomUUID())).rejects.toThrow(TransientFailureError);
    await orm.close();
  });
});

describe("the ledger pages (FR-60)", () => {
  async function walletWithBets(count: number) {
    const wallet = await open("1000.00");
    for (let i = 0; i < count; i++) {
      await world.useCase.execute(
        command({ walletId: wallet.id, playerId: wallet.playerId }, { money: brl("1.00") }),
      );
    }
    return wallet;
  }

  async function allPages(walletId: string, limit: number) {
    const versions: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await world.queries.getLedger(walletId, { cursor, limit });
      versions.push(...page.entries.map((entry) => entry.walletVersion));
      cursor = page.nextCursor;
    } while (cursor);
    return versions;
  }

  test("the opening entry comes first, then every movement in order", async () => {
    const wallet = await walletWithBets(6);
    const page = await world.queries.getLedger(wallet.id, { limit: 200 });
    expect(page.entries.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(page.entries[0]?.transactionId).toBeDefined();
    expect(page.nextCursor).toBeUndefined();
  });

  test.each([1, 2, 3, 7, 50])("pages of %i visit every entry exactly once", async (limit) => {
    const wallet = await walletWithBets(6);
    expect(await allPages(wallet.id, limit)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  // The done criterion: a cursor stays valid while entries are added.
  test("the cursor stays stable while entries are appended between pages", async () => {
    const wallet = await walletWithBets(5);
    const first = await world.queries.getLedger(wallet.id, { limit: 3 });
    expect(first.entries.map((e) => e.walletVersion)).toEqual([1, 2, 3]);

    for (let i = 0; i < 4; i++) {
      await world.useCase.execute(
        command({ walletId: wallet.id, playerId: wallet.playerId }, { money: brl("1.00") }),
      );
    }
    const rest: number[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await world.queries.getLedger(wallet.id, { cursor, limit: 3 });
      rest.push(...page.entries.map((e) => e.walletVersion));
      cursor = page.nextCursor;
    }
    // Nothing skipped, nothing repeated, and the new entries are simply at the end.
    expect([...first.entries.map((e) => e.walletVersion), ...rest]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("paging while others write at the same time still sees each entry once", async () => {
    const wallet = await walletWithBets(5);
    const writing = Promise.all(
      Array.from({ length: 12 }, () =>
        world.useCase.execute(
          command({ walletId: wallet.id, playerId: wallet.playerId }, { money: brl("1.00") }),
        ),
      ),
    );
    const seen = await allPages(wallet.id, 2);
    await writing;
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    const final = await allPages(wallet.id, 200);
    expect(final).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });

  test("a cursor only ever reaches the wallet it is used on", async () => {
    const mine = await walletWithBets(4);
    const theirs = await walletWithBets(4);
    const cursor = (await world.queries.getLedger(mine.id, { limit: 2 })).nextCursor;
    const page = await world.queries.getLedger(theirs.id, { cursor, limit: 200 });
    for (const entry of page.entries) expect(entry.walletId).toBe(theirs.id);
  });

  test("an empty ledger (a zero wallet) is an empty page", async () => {
    const wallet = await open("0.00");
    expect(await world.queries.getLedger(wallet.id, {})).toEqual({ entries: [], nextCursor: undefined });
  });

  test("the page query is a range scan on the unique (wallet, version) index, not a sort", async () => {
    const wallet = await walletWithBets(3);
    const plan = await world.sql(
      "explain select * from wallet_ledger_entries where wallet_id = ? and wallet_version > 0 order by wallet_version asc limit 51",
      [wallet.id],
    );
    const text = plan.map((row) => Object.values(row)[0]).join("\n");
    expect(text).not.toMatch(/\bSort\b/);
  });
});

describe("the database orders and limits a ledger page, not the application (SR-04)", () => {
  // With an index scan available, PostgreSQL returns this table's rows already ordered, which would hide a missing
  // ORDER BY. So the test builds a database that cannot use one, and inserts the entries out of order.
  test("a page is the first rows by version, however they were stored, and no more", async () => {
    const versions = [5, 3, 9, 2, 7, 4];
    const wallet = await open("100.00");
    for (const version of versions) {
      const transaction = randomUUID();
      await world.sql(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, observed_balance, processed_at, created_at, updated_at)
         values (?, 'provider-a', ?, ?, ?, ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PROCESSED', 1, now(), now(), now())`,
        [transaction, transaction, transaction, "a".repeat(64), wallet.id, wallet.playerId],
      );
      await world.sql(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
         values (?, ?, ?, 'CREDIT', 1, 'BRL', 0, 1, ?, now())`,
        [randomUUID(), wallet.id, transaction, version],
      );
    }
    const name = (await world.sql("select current_database() as name"))[0]?.name as string;
    await world.sql(`alter database ${name} set enable_indexscan = off`);
    await world.sql(`alter database ${name} set enable_bitmapscan = off`);
    await world.sql(`alter database ${name} set enable_indexonlyscan = off`);

    // New connections only: ALTER DATABASE does not touch the ones already open.
    const orm = await MikroORM.init(
      createOrmConfig(world.databaseUrl(), "migrations", wageringEntitySchemas),
    );
    try {
      const reader = new MikroOrmWalletReader(orm, { lockTimeoutMs: 1_000, statementTimeoutMs: 5_000 });
      const plan = await orm.em.getConnection().execute("show enable_indexscan");
      expect(plan[0]?.enable_indexscan).toBe("off");

      const all = await reader.ledgerAfter(wallet.id, 0, 100);
      expect(all.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4, 5, 7, 9]);
      const first = await reader.ledgerAfter(wallet.id, 0, 3);
      expect(first.map((entry) => entry.walletVersion)).toEqual([1, 2, 3]);
      const next = await reader.ledgerAfter(wallet.id, 3, 2);
      expect(next.map((entry) => entry.walletVersion)).toEqual([4, 5]);
      expect(await reader.ledgerAfter(wallet.id, 9, 10)).toEqual([]);
    } finally {
      await orm.close();
    }
  });
});

describe("a transaction of every kind keeps the ledger honest", () => {
  test("after opening, betting, winning, refunding and rolling back, the ledger explains the balance", async () => {
    const wallet = await open("100.00");
    const target = { walletId: wallet.id, playerId: wallet.playerId };
    const bet = command(target, { money: brl("30.00") });
    await world.useCase.execute(bet);
    await world.useCase.execute(
      command(target, {
        kind: Kind.Refund,
        money: brl("30.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    const win = command(target, { kind: Kind.Win, money: brl("45.50") });
    await world.useCase.execute(win);
    await world.useCase.execute(
      command(target, {
        kind: Kind.Rollback,
        money: brl("45.50"),
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    await world.useCase.execute(command(target, { kind: Kind.Loss, money: brl("0.00") }));
    expect((await world.walletState(wallet.id)).balance).toBe("100.00");
    await world.expectLedgerExplainsBalance(wallet.id);
  });
});
