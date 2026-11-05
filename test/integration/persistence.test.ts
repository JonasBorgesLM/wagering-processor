import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../src/platform/database/mikro-orm.config";
import { Money } from "../../src/wagering/domain/money";
import { WagerTransactionKind as Kind, WagerTransaction } from "../../src/wagering/domain/wager-transaction";
import { Wallet } from "../../src/wagering/domain/wallet";
import type { WalletLedgerEntry } from "../../src/wagering/domain/wallet-ledger-entry";
import {
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  transactionFromRecord,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from "../../src/wagering/infrastructure/persistence/mappers";
import {
  LedgerEntrySchema,
  WagerTransactionSchema,
  WalletSchema,
  wageringEntitySchemas,
} from "../../src/wagering/infrastructure/persistence/schemas";
import { createTestDatabase, type TestDatabase } from "../support/database";

// Each aggregate goes domain -> record -> INSERT -> a fresh read -> record -> domain, against real PostgreSQL,
// and must come back the same. The ORM is in the middle on purpose: the claim is about what survives it.

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });
const at = (ms: number) => new Date(Date.UTC(2026, 10, 5, 12, 30, 45, ms));
const iso = (date: Date | undefined) => date?.toISOString() ?? null;

let database: TestDatabase;
let orm: MikroORM;

beforeAll(async () => {
  database = await createTestDatabase();
  orm = await MikroORM.init(createOrmConfig(database.url, "migrations", wageringEntitySchemas));
  await orm.migrator.up();
});

afterAll(async () => {
  await orm.close();
  await database.drop();
});

const run = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);

// A fresh fork per call, so nothing is served from an identity map: every read goes to the database.
const insert = <T extends object>(schema: Parameters<typeof orm.em.insert>[0], record: T) =>
  orm.em.fork().insert(schema, record);
const load = <T>(schema: unknown, id: string) =>
  orm.em.fork().findOneOrFail(schema as never, { id } as never) as Promise<T>;

// ---- snapshots: everything observable, as plain values, so one comparison covers a whole object

const walletSnap = (w: Wallet) => ({
  id: w.id,
  playerId: w.playerId,
  currency: w.currency,
  balance: w.balance.toString(),
  version: w.version,
  createdAt: iso(w.createdAt),
  updatedAt: iso(w.updatedAt),
});

const transactionSnap = (t: WagerTransaction) => ({
  id: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  idempotencyKey: t.idempotencyKey,
  payloadHash: t.payloadHash,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toString(),
  referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
  createdAt: iso(t.createdAt),
  status: t.status,
  referenceTransactionId: t.referenceTransactionId ?? null,
  failureCode: t.failureCode ?? null,
  observedBalance: t.observedBalance?.toString() ?? null,
  processedAt: iso(t.processedAt),
});

const entrySnap = (e: WalletLedgerEntry) => ({
  id: e.id,
  walletId: e.walletId,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toString(),
  balanceBefore: e.balanceBefore.toString(),
  balanceAfter: e.balanceAfter.toString(),
  walletVersion: e.walletVersion,
  createdAt: iso(e.createdAt),
});

// ---- persisting domain objects through the mappers

async function saveWallet(wallet: Wallet) {
  await insert(WalletSchema, walletToRecord(wallet));
}

async function saveTransaction(transaction: WagerTransaction, updatedAt = at(900)) {
  await insert(WagerTransactionSchema, transactionToRecord(transaction, updatedAt));
}

async function saveEntry(entry: WalletLedgerEntry) {
  await insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
}

/** A wallet whose opening is fully persisted: the wallet, its OPENING transaction and the opening entry. */
async function openedWallet(initial: string, playerId = randomUUID()) {
  const openingTransaction = randomUUID();
  const { wallet, openingEntry } = Wallet.open({
    id: randomUUID(),
    playerId,
    initialBalance: brl(initial),
    at: at(123),
    ...(brl(initial).isZero()
      ? {}
      : { opening: { transactionId: openingTransaction, entryId: randomUUID() } }),
  });
  await saveWallet(wallet);
  if (openingEntry) {
    const opening = WagerTransaction.createOpening({
      id: openingTransaction,
      walletId: wallet.id,
      playerId,
      money: brl(initial),
      createdAt: at(123),
    });
    opening.markProcessed(undefined, wallet.balance, at(124));
    await saveTransaction(opening);
    await saveEntry(openingEntry);
  }
  return { wallet, openingEntry };
}

function transactionOn(wallet: Wallet, kind: Kind, overrides: Record<string, unknown> = {}) {
  const external = randomUUID();
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: "provider-a",
    externalTransactionId: external,
    idempotencyKey: `provider-a:${external}`,
    payloadHash: "ab".repeat(32),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl("25.00"),
    createdAt: at(321),
    ...(kind === Kind.Refund || kind === Kind.Rollback ? { referenceExternalTransactionId: "not-yet" } : {}),
    ...overrides,
  });
}

/** A processed BET that a reversal can point at, persisted. */
async function processedBet(wallet: Wallet) {
  const bet = transactionOn(wallet, Kind.Bet);
  bet.markProcessed(undefined, brl("75.00"), at(5));
  await saveTransaction(bet);
  return bet;
}

describe("wallet round trip", () => {
  // Built in memory and saved once: these cases need the wallet's state, not a ledger behind it.
  const open = (initial: string) =>
    Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: brl(initial),
      at: at(123),
      ...(brl(initial).isZero() ? {} : { opening: { transactionId: randomUUID(), entryId: randomUUID() } }),
    }).wallet;

  const cases: Array<[string, () => Wallet]> = [
    ["a freshly opened wallet", () => open("1000.00")],
    ["a zero wallet", () => open("0.00")],
    [
      "a wallet after several movements",
      () => {
        const wallet = open("100.00");
        let n = 0;
        for (const [kind, amount] of [
          ["credit", "5.50"],
          ["debit", "0.01"],
          ["credit", "250.00"],
          ["debit", "10.00"],
        ] as const) {
          wallet[kind](brl(amount), {
            transactionId: randomUUID(),
            entryId: randomUUID(),
            at: at(100 + ++n),
          });
        }
        return wallet;
      },
    ],
    ["the largest balance the column holds", () => open("999999999999999999.99")],
  ];

  test.each(cases)("%s", async (_name, build) => {
    const wallet = build();
    await saveWallet(wallet);
    const back = walletFromRecord(await load(WalletSchema, wallet.id));
    expect(back).toBeInstanceOf(Wallet);
    expect(walletSnap(back)).toStrictEqual(walletSnap(wallet));
  });

  test("the loaded wallet carries on: its next movement has the right version and balance", async () => {
    const { wallet } = await openedWallet("100.00");
    const back = walletFromRecord(await load(WalletSchema, wallet.id));
    const entry = back.debit(brl("40.00"), { transactionId: randomUUID(), entryId: randomUUID(), at: at(1) });
    expect(entry.walletVersion).toBe(2);
    expect(entry.balanceBefore.toString()).toBe("100.00 BRL");
    expect(back.balance.toString()).toBe("60.00 BRL");
  });
});

describe("wager transaction round trip: every outcome", () => {
  type Build = (wallet: Wallet) => Promise<WagerTransaction> | WagerTransaction;
  const processed =
    (kind: Kind, extra: Record<string, unknown> = {}): Build =>
    async (wallet) => {
      const t = transactionOn(wallet, kind, extra);
      t.markProcessed(undefined, brl("75.00"), at(5));
      return t;
    };
  const reversalOfNewBet =
    (kind: Kind): Build =>
    async (wallet) => {
      const bet = await processedBet(wallet);
      const t = transactionOn(wallet, kind, { referenceExternalTransactionId: bet.externalTransactionId });
      t.markProcessed(bet.id, brl("100.00"), at(6));
      return t;
    };

  const cases: Array<[string, Build]> = [
    ["a processed BET", processed(Kind.Bet)],
    ["a processed LOSS of zero", processed(Kind.Loss, { money: brl("0.00") })],
    [
      "a processed WIN that linked its BET",
      async (wallet) => {
        const bet = await processedBet(wallet);
        const t = transactionOn(wallet, Kind.Win, {
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        t.markProcessed(bet.id, brl("100.00"), at(6));
        return t;
      },
    ],
    ["a processed REFUND that linked its BET", reversalOfNewBet(Kind.Refund)],
    ["a processed ROLLBACK that linked its BET", reversalOfNewBet(Kind.Rollback)],
    [
      "a BET rejected for funds, with the balance it saw",
      (wallet) => {
        const t = transactionOn(wallet, Kind.Bet);
        t.reject("INSUFFICIENT_FUNDS", brl("10.00"));
        return t;
      },
    ],
    [
      "a rejection that withholds the balance",
      (wallet) => {
        const t = transactionOn(wallet, Kind.Bet);
        t.reject("PLAYER_WALLET_MISMATCH", undefined);
        return t;
      },
    ],
    [
      "a rejection in another currency",
      (wallet) => {
        const t = transactionOn(wallet, Kind.Bet, { money: usd("25.00") });
        t.reject("CURRENCY_MISMATCH", undefined);
        return t;
      },
    ],
    [
      "a REFUND waiting for its reference",
      (wallet) => {
        const t = transactionOn(wallet, Kind.Refund);
        t.markPendingReference(brl("75.00"));
        return t;
      },
    ],
    [
      "a ROLLBACK whose reference never came",
      (wallet) => {
        const t = transactionOn(wallet, Kind.Rollback);
        t.markPendingReference(brl("75.00"));
        t.reject("REFERENCE_NOT_FOUND", brl("75.00"));
        return t;
      },
    ],
    [
      "a BET that failed for infrastructure reasons",
      (wallet) => {
        const t = transactionOn(wallet, Kind.Bet);
        t.fail("SETTLEMENT_FAILED");
        return t;
      },
    ],
    [
      "a waiting REFUND that then failed, keeping the balance it saw",
      (wallet) => {
        const t = transactionOn(wallet, Kind.Refund);
        t.markPendingReference(brl("75.00"));
        t.fail("SETTLEMENT_FAILED");
        return t;
      },
    ],
    [
      "an OPENING",
      (wallet) => {
        const t = WagerTransaction.createOpening({
          id: randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: brl("500.00"),
          createdAt: at(321),
        });
        t.markProcessed(undefined, brl("500.00"), at(322));
        return t;
      },
    ],
  ];

  test.each(cases)("%s", async (_name, build) => {
    const { wallet } = await openedWallet("0.00");
    const transaction = await build(wallet);
    await saveTransaction(transaction);
    const back = transactionFromRecord(await load(WagerTransactionSchema, transaction.id));
    expect(back).toBeInstanceOf(WagerTransaction);
    expect(transactionSnap(back)).toStrictEqual(transactionSnap(transaction));
  });

  test("a loaded transaction is still bound by its lifecycle", async () => {
    const { wallet } = await openedWallet("0.00");
    const settled = transactionOn(wallet, Kind.Bet);
    settled.markProcessed(undefined, brl("75.00"), at(5));
    await saveTransaction(settled);
    const back = transactionFromRecord(await load(WagerTransactionSchema, settled.id));
    expect(back.isTerminal()).toBe(true);
    expect(() => back.reject("INSUFFICIENT_FUNDS", undefined)).toThrow();
  });

  test("nothing is stored as the string 'null': absent values are SQL NULL", async () => {
    const { wallet } = await openedWallet("0.00");
    const bet = transactionOn(wallet, Kind.Bet);
    bet.markProcessed(undefined, brl("75.00"), at(5));
    await saveTransaction(bet);
    const [row] = await run(
      "select reference_external_transaction_id is null as ref, reference_transaction_id is null as link, failure_code is null as code from wager_transactions where id = ?",
      [bet.id],
    );
    expect(row).toEqual({ ref: true, link: true, code: true });
  });

  // The audit column the domain does not have: whoever writes the row says when (§7.9 stays answerable).
  test("updated_at is the one the writer supplied", async () => {
    const { wallet } = await openedWallet("0.00");
    const t = transactionOn(wallet, Kind.Bet);
    t.markProcessed(undefined, brl("75.00"), at(5));
    await saveTransaction(t, at(777));
    const [row] = await run("select updated_at from wager_transactions where id = ?", [t.id]);
    expect(new Date(row?.updated_at).toISOString()).toBe(at(777).toISOString());
  });
});

describe("ledger entry round trip", () => {
  async function movements() {
    const { wallet, openingEntry } = await openedWallet("100.00");
    const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
    for (const [kind, amount] of [
      ["debit", "25.00"],
      ["credit", "10.50"],
      ["debit", "0.01"],
    ] as const) {
      const bet = transactionOn(wallet, Kind.Bet);
      bet.markProcessed(undefined, wallet.balance, at(5));
      await saveTransaction(bet);
      const entry = wallet[kind](brl(amount), { transactionId: bet.id, entryId: randomUUID(), at: at(50) });
      await saveEntry(entry);
      entries.push(entry);
    }
    return entries;
  }

  test("every entry of a real sequence comes back identical, and still balanced", async () => {
    const entries = await movements();
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      const back = ledgerEntryFromRecord(await load(LedgerEntrySchema, entry.id));
      expect(entrySnap(back)).toStrictEqual(entrySnap(entry));
      expect(back.isBalanced()).toBe(true);
    }
  });

  test("the chain survives: each entry's balance before is the previous one's after", async () => {
    const entries = await movements();
    const loaded = await Promise.all(
      entries.map(async (e) => ledgerEntryFromRecord(await load(LedgerEntrySchema, e.id))),
    );
    loaded.sort((a, b) => a.walletVersion - b.walletVersion);
    loaded.forEach((entry, index) => {
      const previous = loaded[index - 1];
      if (previous) expect(entry.balanceBefore.equals(previous.balanceAfter)).toBe(true);
    });
  });
});

describe("another currency, in every table", () => {
  // The mappers take the currency from the row. A mapper that assumed BRL would pass every test above.
  test("a USD wallet, its transaction and its ledger entry", async () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: usd("50.00"),
      at: at(1),
      opening: { transactionId: randomUUID(), entryId: randomUUID() },
    });
    const bet = transactionOn(wallet.wallet, Kind.Bet, { money: usd("5.00") });
    bet.markProcessed(undefined, usd("45.00"), at(5));
    const opening = WagerTransaction.createOpening({
      id: wallet.openingEntry?.transactionId ?? randomUUID(),
      walletId: wallet.wallet.id,
      playerId: wallet.wallet.playerId,
      money: usd("50.00"),
      createdAt: at(1),
    });
    opening.markProcessed(undefined, usd("50.00"), at(2));
    // Debited in memory first, so the wallet row is saved in the state the ledger leads to.
    const entry = wallet.wallet.debit(usd("5.00"), {
      transactionId: bet.id,
      entryId: randomUUID(),
      at: at(6),
    });

    // Saved in the order the foreign keys need: wallet, then transactions, then entries.
    await saveWallet(wallet.wallet);
    await saveTransaction(opening);
    await saveTransaction(bet);
    if (wallet.openingEntry) await saveEntry(wallet.openingEntry);
    await saveEntry(entry);

    const backWallet = walletFromRecord(await load(WalletSchema, wallet.wallet.id));
    const backBet = transactionFromRecord(await load(WagerTransactionSchema, bet.id));
    const backEntry = ledgerEntryFromRecord(await load(LedgerEntrySchema, entry.id));
    expect(backWallet.currency).toBe("USD");
    expect(backWallet.balance.toString()).toBe("45.00 USD");
    expect(backBet.money.toString()).toBe("5.00 USD");
    expect(backBet.observedBalance?.toString()).toBe("45.00 USD");
    expect(backEntry.money.currency).toBe("USD");
    expect(backEntry.balanceBefore.toString()).toBe("50.00 USD");
    expect(backEntry.balanceAfter.toString()).toBe("45.00 USD");
    expect(backEntry.isBalanced()).toBe(true);
  });
});

describe("amounts stay exact through the ORM (FR-02)", () => {
  // 2^53 + 1 is the first integer a double cannot hold, and 18 digits is the most the column takes.
  test.each(["0.01", "0.00", "9007199254740993.00", "999999999999999999.99", "123456789012345678.90"])(
    "%s, in every amount column of every table",
    async (amount) => {
      const { wallet } = await openedWallet("0.00");
      const big = brl(amount);

      const bet = transactionOn(wallet, Kind.Loss, { money: big });
      bet.markProcessed(undefined, big, at(5));
      await saveTransaction(bet);
      const back = transactionFromRecord(await load(WagerTransactionSchema, bet.id));
      expect(back.money.toJSON().amount).toBe(amount);
      expect(back.observedBalance?.toJSON().amount).toBe(amount);

      // What PostgreSQL itself holds, read as text, so the claim is about storage and not only about the mapper.
      const [stored] = await run(
        "select amount::text as amount, observed_balance::text as balance from wager_transactions where id = ?",
        [bet.id],
      );
      expect(stored).toEqual({ amount, balance: amount });
    },
  );

  test("a ledger entry and a wallet at the extreme, too", async () => {
    const extreme = brl("999999999999999999.99");
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.zero("BRL"),
      at: at(1),
    }).wallet;
    await saveWallet(wallet);
    const funding = transactionOn(wallet, Kind.Win, { money: extreme });
    funding.markProcessed(undefined, extreme, at(2));
    await saveTransaction(funding);
    const entry = wallet.credit(extreme, { transactionId: funding.id, entryId: randomUUID(), at: at(3) });
    await saveEntry(entry);
    await run("update wallets set balance = ?, version = ? where id = ?", [
      wallet.balance.toJSON().amount,
      wallet.version,
      wallet.id,
    ]);

    const backEntry = ledgerEntryFromRecord(await load(LedgerEntrySchema, entry.id));
    const backWallet = walletFromRecord(await load(WalletSchema, wallet.id));
    expect(backEntry.balanceAfter.toJSON().amount).toBe("999999999999999999.99");
    expect(backWallet.balance.toJSON().amount).toBe("999999999999999999.99");
    expect(backEntry.isBalanced()).toBe(true);
  });
});

describe("timestamps keep their millisecond", () => {
  test.each([0, 1, 123, 999])("%i ms", async (ms) => {
    const { wallet } = await openedWallet("0.00");
    const t = transactionOn(wallet, Kind.Bet, { createdAt: at(ms) });
    t.markProcessed(undefined, brl("1.00"), at(ms));
    await saveTransaction(t);
    const back = transactionFromRecord(await load(WagerTransactionSchema, t.id));
    expect(back.createdAt.toISOString()).toBe(at(ms).toISOString());
    expect(back.processedAt?.toISOString()).toBe(at(ms).toISOString());
  });
});

describe("what the database holds and the code maps cannot drift apart", () => {
  const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const columnsOf = async (table: string) => {
    const rows = await run(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = ? order by 1",
      [table],
    );
    return rows.map((row) => row.column_name as string);
  };

  test("every column has a property, in the record, the mapping and the mapper's output", async () => {
    const { wallet } = await openedWallet("100.00");
    const t = transactionOn(wallet, Kind.Bet);
    t.markProcessed(undefined, brl("75.00"), at(5));
    const entry = wallet.debit(brl("25.00"), { transactionId: t.id, entryId: randomUUID(), at: at(6) });

    const subjects = [
      ["wallets", WalletSchema, walletToRecord(wallet)],
      ["wager_transactions", WagerTransactionSchema, transactionToRecord(t, at(7))],
      ["wallet_ledger_entries", LedgerEntrySchema, ledgerEntryToRecord(entry)],
    ] as const;
    for (const [table, schema, record] of subjects) {
      const columns = await columnsOf(table);
      const mapped = Object.keys(record).map(snake).sort();
      const declared = Object.values(orm.getMetadata().get(schema.meta.class).props)
        .map((p) => p.fieldNames[0])
        .sort();
      expect(mapped, `${table}: mapper output`).toEqual(columns);
      expect(declared, `${table}: EntitySchema`).toEqual(columns);
    }
  });
});

describe("the declared types and nullability match the database", () => {
  // The ORM never generates this schema, so nothing makes the two agree except this. It is what keeps a numeric
  // column from being declared as a number (which would be harmless today, and a silent loss of cents the day an
  // ORM upgrade starts converting by declared type), and a nullable column from being declared required.
  const runtimeTypeFor: Record<string, string> = {
    numeric: "string",
    uuid: "string",
    "character varying": "string",
    character: "string",
    integer: "number",
    "timestamp with time zone": "Date",
  };

  const subjects = [
    ["wallets", WalletSchema],
    ["wager_transactions", WagerTransactionSchema],
    ["wallet_ledger_entries", LedgerEntrySchema],
  ] as const;

  test.each(subjects)("%s", async (table, schema) => {
    const columns = await run(
      "select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = ?",
      [table],
    );
    const props = Object.values(orm.getMetadata().get(schema.meta.class).props);
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      const prop = props.find((candidate) => candidate.fieldNames[0] === column.column_name);
      expect(prop, `${table}.${column.column_name} is mapped`).toBeDefined();
      expect(prop?.runtimeType, `${table}.${column.column_name} (${column.data_type})`).toBe(
        runtimeTypeFor[column.data_type as string],
      );
      expect(Boolean(prop?.nullable), `${table}.${column.column_name} nullable`).toBe(
        column.is_nullable === "YES",
      );
    }
  });

  test("the data types in use are all covered by the table above", async () => {
    const rows = await run(
      "select distinct data_type from information_schema.columns where table_schema = 'public' and table_name in ('wallets', 'wager_transactions', 'wallet_ledger_entries')",
    );
    for (const row of rows) expect(Object.keys(runtimeTypeFor)).toContain(row.data_type as string);
  });
});

describe("the database is the last line", () => {
  // INT-24: the edge reports a bad id as a validation error, and this is what stands behind it.
  test("an id that is not a UUID is refused", async () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: randomUUID(),
      initialBalance: brl("0.00"),
      at: at(1),
    }).wallet;
    await expect(saveWallet(wallet)).rejects.toThrow(/invalid input syntax for type uuid/);
  });

  test("a key longer than its column is refused, not truncated (SR-04)", async () => {
    const { wallet } = await openedWallet("0.00");
    const t = transactionOn(wallet, Kind.Bet, { externalTransactionId: "x".repeat(256) });
    t.markProcessed(undefined, brl("1.00"), at(1));
    await expect(saveTransaction(t)).rejects.toThrow(/value too long for type character varying\(255\)/);
  });
});
