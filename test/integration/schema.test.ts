import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../src/platform/database/mikro-orm.config";
import { createTestDatabase, type TestDatabase } from "../support/database";

// §5.9: these guarantees must hold in the schema, so these tests talk to PostgreSQL in raw SQL, with no
// application code in the way. Each changes one thing on a row that is otherwise valid, and asserts the name of
// the constraint that refused it, because a test expecting only "an error" passes for the wrong reason.

type Row = Record<string, unknown>;

let database: TestDatabase;
let orm: MikroORM;
const NOW = "2026-11-05T12:00:00.000Z";

const run = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);

function insert(table: string, row: Row) {
  const columns = Object.keys(row);
  const sql = `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`;
  return run(sql, Object.values(row));
}

async function wallet(overrides: Row = {}): Promise<Row> {
  const row = {
    id: randomUUID(),
    player_id: randomUUID(),
    currency: "BRL",
    balance: "100.00",
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  await insert("wallets", row);
  return row;
}

/** A complete, valid processed BET on a wallet of its own, unless told otherwise. */
function transactionRow(walletId: string, overrides: Row = {}): Row {
  const external = randomUUID();
  return {
    id: randomUUID(),
    provider_id: "provider-a",
    external_transaction_id: external,
    idempotency_key: `provider-a:${external}`,
    payload_hash: "a".repeat(64),
    wallet_id: walletId,
    player_id: randomUUID(),
    round_id: "round-1",
    game_id: "game-1",
    kind: "BET",
    amount: "25.00",
    currency: "BRL",
    status: "PROCESSED",
    observed_balance: "75.00",
    processed_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function transaction(walletId: string, overrides: Row = {}): Promise<Row> {
  const row = transactionRow(walletId, overrides);
  await insert("wager_transactions", row);
  return row;
}

function entryRow(walletId: string, transactionId: string, overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: "DEBIT",
    amount: "25.00",
    currency: "BRL",
    balance_before: "100.00",
    balance_after: "75.00",
    wallet_version: 2,
    created_at: NOW,
    ...overrides,
  };
}

/** A processed reversal of `reference`, valid in itself. */
const reversalOf = (reference: Row, kind: "REFUND" | "ROLLBACK", overrides: Row = {}): Row => ({
  kind,
  reference_external_transaction_id: reference.external_transaction_id,
  reference_transaction_id: reference.id,
  ...overrides,
});

async function refusedBy(constraint: string, attempt: () => Promise<unknown>): Promise<void> {
  const error = await attempt().then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(String(error), `expected a refusal by ${constraint}`).toContain(`"${constraint}"`);
}

beforeAll(async () => {
  database = await createTestDatabase();
  orm = await MikroORM.init(createOrmConfig(database.url));
  await orm.migrator.up();
});

afterAll(async () => {
  await orm.close();
  await database.drop();
});

describe("migrations (NFR-01)", () => {
  test("run up, down and up again on real PostgreSQL", async () => {
    const tables = async () => {
      const rows = await run(
        "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations' order by 1",
      );
      return rows.map((row) => row.tablename);
    };
    const all = [
      "inbox_messages",
      "outbox_messages",
      "wager_transactions",
      "wallet_ledger_entries",
      "wallets",
    ];
    expect(await tables()).toEqual(all);
    await orm.migrator.down();
    expect(await tables()).toEqual([]);
    await orm.migrator.up();
    expect(await tables()).toEqual(all);
  });
});

describe("positive controls: valid rows are accepted", () => {
  // Without these, every refusal below could be a schema that refuses everything.
  test("a wallet, a processed transaction, its entry, and inbox and outbox rows", async () => {
    const w = await wallet();
    const t = await transaction(w.id as string);
    await insert("wallet_ledger_entries", entryRow(w.id as string, t.id as string));
    await insert("inbox_messages", {
      consumer_name: "c",
      message_id: randomUUID(),
      payload_hash: "a".repeat(64),
      received_at: NOW,
    });
    await insert("outbox_messages", {
      id: randomUUID(),
      aggregate_id: w.id,
      event_type: "E",
      payload: "{}",
      occurred_at: NOW,
      next_attempt_at: NOW,
    });
  });

  test("a zero balance and a zero LOSS", async () => {
    const w = await wallet({ balance: "0.00" });
    await transaction(w.id as string, { kind: "LOSS", amount: "0.00", observed_balance: "0.00" });
  });

  test("a rejection with no balance, and a waiting reversal", async () => {
    const w = await wallet();
    await transaction(w.id as string, {
      status: "REJECTED",
      failure_code: "PLAYER_WALLET_MISMATCH",
      observed_balance: null,
      processed_at: null,
    });
    await transaction(w.id as string, {
      kind: "REFUND",
      reference_external_transaction_id: "not-yet",
      status: "PENDING_REFERENCE",
      processed_at: null,
    });
  });

  test("an OPENING from the internal provider", async () => {
    const w = await wallet();
    await transaction(w.id as string, { kind: "OPENING", provider_id: "internal", amount: "100.00" });
  });
});

describe("wallets", () => {
  test.each(["brl", "BR", "R$1", "12A"])("refuses the currency %p", async (currency) => {
    await refusedBy("ck_wallets_currency", () => wallet({ currency }));
  });

  // Invariant: no negative balance, whatever the code does.
  test("refuses a negative balance", async () => {
    await refusedBy("ck_wallets_balance_non_negative", () => wallet({ balance: "-0.01" }));
  });

  test("an update cannot take the balance below zero either", async () => {
    const w = await wallet({ balance: "10.00" });
    await refusedBy("ck_wallets_balance_non_negative", () =>
      run("update wallets set balance = balance - 10.01 where id = ?", [w.id]),
    );
  });

  test("refuses a version below 1", async () => {
    await refusedBy("ck_wallets_version_positive", () => wallet({ version: 0 }));
  });

  // FR-10
  test("one wallet per player and currency, while another currency is a different wallet", async () => {
    const w = await wallet();
    await refusedBy("uq_wallets_player_currency", () => wallet({ player_id: w.player_id }));
    await wallet({ player_id: w.player_id, currency: "USD" });
  });

  test("a value that overflows the column is refused, not truncated", async () => {
    await expect(wallet({ balance: "1000000000000000000.00" })).rejects.toThrow(/numeric field overflow/);
  });

  // Not a guarantee of the schema, and pinned so nobody assumes it is: numeric(20,2) rounds on input.
  // Money is what refuses a third decimal (FR-01), and this is why nothing else may write amounts.
  test("the column rounds a third decimal instead of refusing it", async () => {
    const w = await wallet({ balance: "1.005" });
    const rows = await run("select balance from wallets where id = ?", [w.id]);
    expect(rows[0]?.balance).toBe("1.01");
  });
});

describe("wager_transactions: duplicate control", () => {
  test("one row per idempotency key (FR-53)", async () => {
    const w = await wallet();
    const t = await transaction(w.id as string);
    await refusedBy("uq_wager_transactions_idempotency_key", () =>
      transaction(w.id as string, { idempotency_key: t.idempotency_key }),
    );
  });

  test("one row per provider and external id, under any key (FR-54)", async () => {
    const w = await wallet();
    const t = await transaction(w.id as string);
    await refusedBy("uq_wager_transactions_provider_external", () =>
      transaction(w.id as string, { external_transaction_id: t.external_transaction_id }),
    );
    await transaction(w.id as string, {
      provider_id: "provider-b",
      external_transaction_id: t.external_transaction_id,
    });
  });

  // INT-21: the derived keys make a second opening collide here.
  test("a second OPENING for a wallet collides", async () => {
    const w = await wallet();
    const opening = {
      kind: "OPENING",
      provider_id: "internal",
      external_transaction_id: `opening-${w.id}`,
      idempotency_key: `internal:opening-${w.id}`,
    };
    await transaction(w.id as string, opening);
    await refusedBy("uq_wager_transactions_idempotency_key", () => transaction(w.id as string, opening));
  });
});

describe("wager_transactions: single reversal (ADR-0006)", () => {
  async function bet() {
    const w = await wallet();
    return { walletId: w.id as string, reference: await transaction(w.id as string) };
  }

  test("a second REFUND of one BET is refused", async () => {
    const { walletId, reference } = await bet();
    await transaction(walletId, reversalOf(reference, "REFUND"));
    await refusedBy("uq_wager_transactions_single_reversal", () =>
      transaction(walletId, reversalOf(reference, "REFUND")),
    );
  });

  // The double credit that the literal rule 7.4 would allow.
  test("REFUND and then ROLLBACK of one BET is refused", async () => {
    const { walletId, reference } = await bet();
    await transaction(walletId, reversalOf(reference, "REFUND"));
    await refusedBy("uq_wager_transactions_single_reversal", () =>
      transaction(walletId, reversalOf(reference, "ROLLBACK")),
    );
  });

  test("ROLLBACK and then REFUND of one BET is refused", async () => {
    const { walletId, reference } = await bet();
    await transaction(walletId, reversalOf(reference, "ROLLBACK"));
    await refusedBy("uq_wager_transactions_single_reversal", () =>
      transaction(walletId, reversalOf(reference, "REFUND")),
    );
  });

  // FR-27
  test("a rejected attempt does not use the reference up", async () => {
    const { walletId, reference } = await bet();
    await transaction(walletId, {
      kind: "ROLLBACK",
      reference_external_transaction_id: reference.external_transaction_id,
      status: "REJECTED",
      failure_code: "REVERSAL_INSUFFICIENT_FUNDS",
      processed_at: null,
    });
    await transaction(walletId, reversalOf(reference, "ROLLBACK"));
  });

  // FR-23: only reversals count, and a WIN is not one.
  test("several WINs may point at one BET", async () => {
    const { walletId, reference } = await bet();
    const win = {
      kind: "WIN",
      reference_external_transaction_id: reference.external_transaction_id,
      reference_transaction_id: reference.id,
    };
    await transaction(walletId, win);
    await transaction(walletId, win);
  });

  test("a reversal can itself be reversed, since it is a different reference", async () => {
    const { walletId, reference } = await bet();
    const refund = await transaction(walletId, reversalOf(reference, "REFUND"));
    await transaction(walletId, reversalOf(refund, "ROLLBACK"));
  });
});

describe("wager_transactions: shape", () => {
  const cases: Array<[string, string, Row]> = [
    ["an unknown kind", "ck_wager_transactions_kind", { kind: "SIDEWAYS" }],
    ["an unknown status", "ck_wager_transactions_status", { status: "DONE", processed_at: null }],
    ["a malformed currency", "ck_wager_transactions_currency", { currency: "brl" }],
    ["a negative amount", "ck_wager_transactions_amount_non_negative", { amount: "-1.00" }],
    ["a zero BET", "ck_wager_transactions_only_loss_may_be_zero", { amount: "0.00" }],
    ["a zero WIN", "ck_wager_transactions_only_loss_may_be_zero", { kind: "WIN", amount: "0.00" }],
    ["a REFUND with no reference", "ck_wager_transactions_reversal_needs_reference", { kind: "REFUND" }],
    ["a ROLLBACK with no reference", "ck_wager_transactions_reversal_needs_reference", { kind: "ROLLBACK" }],
    [
      "a BET with a reference",
      "ck_wager_transactions_standalone_has_no_reference",
      {
        reference_external_transaction_id: "x",
        status: "REJECTED",
        failure_code: "REFERENCE_MISMATCH",
        processed_at: null,
      },
    ],
    [
      "a transaction referencing itself",
      "ck_wager_transactions_no_self_reference",
      {
        kind: "WIN",
        external_transaction_id: "same",
        reference_external_transaction_id: "same",
        status: "PENDING_REFERENCE",
        processed_at: null,
      },
    ],
    ["an OPENING from a provider", "ck_wager_transactions_opening_is_internal", { kind: "OPENING" }],
    [
      "the internal provider on another kind",
      "ck_wager_transactions_opening_is_internal",
      { provider_id: "internal" },
    ],
    [
      "a failure with no code",
      "ck_wager_transactions_failure_code",
      { status: "FAILED", processed_at: null },
    ],
    [
      "a rejection with no code",
      "ck_wager_transactions_failure_code",
      { status: "REJECTED", processed_at: null },
    ],
    [
      "a rejection with an unknown code",
      "ck_wager_transactions_failure_code",
      { status: "REJECTED", failure_code: "NOPE", processed_at: null },
    ],
    [
      "a rejection with the infrastructure code",
      "ck_wager_transactions_failure_code",
      { status: "REJECTED", failure_code: "SETTLEMENT_FAILED", processed_at: null },
    ],
    [
      "a failure with a business code",
      "ck_wager_transactions_failure_code",
      { status: "FAILED", failure_code: "INSUFFICIENT_FUNDS", processed_at: null },
    ],
    [
      "a processed row with a code",
      "ck_wager_transactions_failure_code",
      { failure_code: "INSUFFICIENT_FUNDS" },
    ],
    ["a processed row with no time", "ck_wager_transactions_processed_at", { processed_at: null }],
    [
      "a rejection with a processed time",
      "ck_wager_transactions_processed_at",
      { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" },
    ],
    [
      "a negative observed balance",
      "ck_wager_transactions_observed_balance_non_negative",
      { observed_balance: "-1.00" },
    ],
    [
      "a processed row with no balance",
      "ck_wager_transactions_observed_balance_required",
      { observed_balance: null },
    ],
    [
      "a waiting row with no balance",
      "ck_wager_transactions_observed_balance_required",
      {
        kind: "REFUND",
        reference_external_transaction_id: "x",
        status: "PENDING_REFERENCE",
        processed_at: null,
        observed_balance: null,
      },
    ],
  ];
  test.each(cases)("refuses %s", async (_name, constraint, overrides) => {
    const w = await wallet();
    await refusedBy(constraint, () => transaction(w.id as string, overrides));
  });

  // The wallet does not have to be right for the row to be stored: a mismatch is an auditable rejection.
  test("a rejection in another currency, or for another player, can still be stored", async () => {
    const w = await wallet();
    await transaction(w.id as string, {
      currency: "USD",
      status: "REJECTED",
      failure_code: "CURRENCY_MISMATCH",
      observed_balance: null,
      processed_at: null,
    });
  });
});

describe("wager_transactions: links", () => {
  test("a transaction needs a wallet that exists (INT-12)", async () => {
    await refusedBy("fk_wager_transactions_wallet", () => transaction(randomUUID()));
  });

  test("a processed transaction that declared a reference must be linked to it", async () => {
    const w = await wallet();
    await refusedBy("ck_wager_transactions_reference_link", () =>
      transaction(w.id as string, { kind: "WIN", reference_external_transaction_id: "x" }),
    );
  });

  test("one that declared none cannot be linked", async () => {
    const w = await wallet();
    const t = await transaction(w.id as string);
    await refusedBy("ck_wager_transactions_reference_link", () =>
      transaction(w.id as string, { kind: "WIN", reference_transaction_id: t.id }),
    );
  });

  test("a row that is not processed cannot be linked", async () => {
    const w = await wallet();
    const t = await transaction(w.id as string);
    await refusedBy("ck_wager_transactions_reference_link", () =>
      transaction(w.id as string, {
        ...reversalOf(t, "REFUND"),
        status: "PENDING_REFERENCE",
        processed_at: null,
      }),
    );
  });

  // §7.2: the same wallet. Reversing another wallet's bet would move money with no relation between them.
  test("a reference must be in the same wallet", async () => {
    const mine = await wallet();
    const other = await wallet();
    const theirs = await transaction(other.id as string);
    await refusedBy("fk_wager_transactions_reference_same_wallet", () =>
      transaction(mine.id as string, reversalOf(theirs, "REFUND")),
    );
  });
});

describe("wallet_ledger_entries", () => {
  async function pair() {
    const w = await wallet();
    const t = await transaction(w.id as string);
    return { walletId: w.id as string, transactionId: t.id as string };
  }

  const cases: Array<[string, string, Row]> = [
    // No constraint of its own: the arithmetic check has no true branch for any other direction.
    ["an unknown direction", "ck_ledger_arithmetic", { direction: "SIDEWAYS" }],
    ["a zero amount", "ck_ledger_amount_positive", { amount: "0.00", balance_after: "100.00" }],
    ["a negative amount", "ck_ledger_amount_positive", { amount: "-25.00", balance_after: "125.00" }],
    [
      "a negative balance before",
      "ck_ledger_balance_before_non_negative",
      { balance_before: "-1.00", direction: "CREDIT", amount: "1.00", balance_after: "0.00" },
    ],
    [
      "a debit overdrawing the wallet",
      "ck_ledger_balance_after_non_negative",
      { balance_before: "10.00", amount: "25.00", balance_after: "-15.00" },
    ],
    ["a version below 1", "ck_ledger_version_positive", { wallet_version: 0 }],
    ["a debit that does not add up", "ck_ledger_arithmetic", { balance_after: "75.01" }],
    [
      "a credit that does not add up",
      "ck_ledger_arithmetic",
      { direction: "CREDIT", balance_after: "124.99" },
    ],
    ["a debit recorded as a credit", "ck_ledger_arithmetic", { direction: "CREDIT" }],
    ["a balance that did not move", "ck_ledger_arithmetic", { balance_after: "100.00" }],
  ];
  test.each(cases)("refuses %s", async (_name, constraint, overrides) => {
    const { walletId, transactionId } = await pair();
    await refusedBy(constraint, () =>
      insert("wallet_ledger_entries", entryRow(walletId, transactionId, overrides)),
    );
  });

  // §6.4: no duplicate debit, even if the code applies a transaction twice.
  test("one entry per transaction", async () => {
    const { walletId, transactionId } = await pair();
    await insert("wallet_ledger_entries", entryRow(walletId, transactionId));
    await refusedBy("uq_ledger_one_entry_per_transaction", () =>
      insert("wallet_ledger_entries", entryRow(walletId, transactionId, { wallet_version: 3 })),
    );
  });

  // A last barrier against a lost update: two writers cannot both claim version 2.
  test("one entry per wallet version, and each wallet counts its own", async () => {
    const { walletId, transactionId } = await pair();
    await insert("wallet_ledger_entries", entryRow(walletId, transactionId));
    const another = await transaction(walletId);
    await refusedBy("uq_ledger_wallet_version", () =>
      insert("wallet_ledger_entries", entryRow(walletId, another.id as string)),
    );
    const other = await pair();
    await insert("wallet_ledger_entries", entryRow(other.walletId, other.transactionId));
  });

  test("an entry is in its wallet's currency", async () => {
    const { walletId, transactionId } = await pair();
    await refusedBy("fk_ledger_wallet_same_currency", () =>
      insert("wallet_ledger_entries", entryRow(walletId, transactionId, { currency: "USD" })),
    );
  });

  test("an entry cannot sit on a wallet other than its transaction's", async () => {
    const { transactionId } = await pair();
    const other = await wallet();
    await refusedBy("fk_ledger_transaction_same_wallet", () =>
      insert("wallet_ledger_entries", entryRow(other.id as string, transactionId)),
    );
  });

  test("an entry needs a transaction that exists", async () => {
    const w = await wallet();
    await refusedBy("fk_ledger_transaction_same_wallet", () =>
      insert("wallet_ledger_entries", entryRow(w.id as string, randomUUID())),
    );
  });
});

describe("inbox_messages (§10)", () => {
  const row = (overrides: Row = {}) => ({
    consumer_name: "wager-consumer",
    message_id: randomUUID(),
    payload_hash: "a".repeat(64),
    received_at: NOW,
    ...overrides,
  });

  test("one row per consumer and message, while another consumer keeps its own", async () => {
    const first = row();
    await insert("inbox_messages", first);
    await refusedBy("pk_inbox_messages", () => insert("inbox_messages", first));
    await insert("inbox_messages", { ...first, consumer_name: "another-consumer" });
  });
});

describe("outbox_messages (§11)", () => {
  const row = (overrides: Row = {}) => ({
    id: randomUUID(),
    aggregate_id: randomUUID(),
    event_type: "WalletBalanceChanged",
    payload: "{}",
    occurred_at: NOW,
    next_attempt_at: NOW,
    ...overrides,
  });

  test("an event id is stored once", async () => {
    const event = row();
    await insert("outbox_messages", event);
    await refusedBy("outbox_messages_pkey", () => insert("outbox_messages", event));
  });

  test("attempts cannot be negative, and start at zero", async () => {
    await refusedBy("ck_outbox_attempts_non_negative", () =>
      insert("outbox_messages", row({ attempts: -1 })),
    );
    const event = row();
    await insert("outbox_messages", event);
    const rows = await run("select attempts from outbox_messages where id = ?", [event.id]);
    expect(rows[0]?.attempts).toBe(0);
  });

  test("the claim query can use the partial index on due rows", async () => {
    const rows = await run("select indexdef from pg_indexes where indexname = 'ix_outbox_due'");
    expect(rows[0]?.indexdef).toContain("WHERE (published_at IS NULL)");
  });
});
