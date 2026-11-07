import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  DuplicateOperationError,
  ExternalIdConflictError,
  IdempotencyConflictError,
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../src/wagering/application/errors";
import { InvalidWagerTransactionError } from "../../src/wagering/domain/errors";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/wagering/domain/wager-transaction";
import {
  classifyPersistenceError,
  MikroOrmUnitOfWork,
  POOL_TIMEOUT_MESSAGE,
} from "../../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work";
import { brl, command, deferred, instrumented, SettlementWorld } from "../support/settlement";

// Requirements: FR-74 (the wait for a connection), NFR-11.

let world: SettlementWorld;
beforeAll(async () => {
  world = await SettlementWorld.create();
});
afterAll(() => world.destroy());

describe("outcomes", () => {
  test("a BET debits, writes one entry and publishes both events", async () => {
    const wallet = await world.openWallet("100.00");
    const result = await world.useCase.execute(command(wallet));
    expect(result).toMatchObject({
      status: Status.Processed,
      failureCode: undefined,
      idempotentReplay: false,
    });
    expect(result.balance?.toString()).toBe("20.00 BRL");
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
    const types = await world.sql(
      "select event_type from outbox_messages where aggregate_id = ? order by event_type",
      [wallet.walletId],
    );
    expect(types.map((row) => row.event_type)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  test("a LOSS moves nothing and leaves the version alone, and still publishes that it was processed", async () => {
    const wallet = await world.openWallet("100.00");
    const result = await world.useCase.execute(command(wallet, { kind: Kind.Loss, money: brl("0.00") }));
    expect(result.status).toBe(Status.Processed);
    expect(result.balance?.toString()).toBe("100.00 BRL");
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 0, events: 1 });
  });

  // A rejection commits: this is why it is a value and not an exception.
  test("a rejection is stored, moves nothing, and publishes its event", async () => {
    const wallet = await world.openWallet("10.00");
    const result = await world.useCase.execute(command(wallet));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: "INSUFFICIENT_FUNDS" });
    expect(result.balance?.toString()).toBe("10.00 BRL");
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "10.00", version: 1 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 0, events: 1 });
    const [row] = await world.sql("select event_type from outbox_messages where aggregate_id = ?", [
      wallet.walletId,
    ]);
    expect(row?.event_type).toBe("WagerTransactionRejected");
  });

  test("another player's wallet is rejected, and the response carries no balance (FR-58)", async () => {
    const wallet = await world.openWallet("100.00");
    const result = await world.useCase.execute(command({ ...wallet, playerId: randomUUID() }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: "PLAYER_WALLET_MISMATCH" });
    expect(result.balance).toBeUndefined();
    const [row] = await world.sql("select payload from outbox_messages where aggregate_id = ?", [
      wallet.walletId,
    ]);
    expect(row?.payload.data.balance).toBeUndefined();
  });

  test("a reversal before its reference waits, and publishes that once", async () => {
    const wallet = await world.openWallet("100.00");
    const result = await world.useCase.execute(
      command(wallet, { kind: Kind.Refund, referenceExternalTransactionId: "not-yet" }),
    );
    expect(result.status).toBe(Status.PendingReference);
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 0, events: 1 });
  });

  test("a REFUND returns the stake, and the second is refused (FR-22)", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet);
    await world.useCase.execute(bet);
    const reversal = { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId };
    const first = await world.useCase.execute(command(wallet, reversal));
    expect(first.balance?.toString()).toBe("100.00 BRL");
    const second = await world.useCase.execute(command(wallet, reversal));
    expect(second).toMatchObject({ status: Status.Rejected, failureCode: "ALREADY_REVERSED" });
    const mixed = await world.useCase.execute(command(wallet, { ...reversal, kind: Kind.Rollback }));
    expect(mixed).toMatchObject({ status: Status.Rejected, failureCode: "ALREADY_REVERSED" });
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 3 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  test("a ROLLBACK of a WIN debits, and is refused with its own code when the money is gone (§7.9)", async () => {
    const wallet = await world.openWallet("10.00");
    const win = command(wallet, { kind: Kind.Win, money: brl("50.00") });
    await world.useCase.execute(win);
    await world.useCase.execute(command(wallet, { money: brl("55.00") }));
    const rollback = await world.useCase.execute(
      command(wallet, {
        kind: Kind.Rollback,
        money: brl("50.00"),
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect(rollback).toMatchObject({ status: Status.Rejected, failureCode: "REVERSAL_INSUFFICIENT_FUNDS" });
    expect((await world.walletState(wallet.walletId)).balance).toBe("5.00");
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });
});

describe("what counts as already reversed (ADR-0006)", () => {
  async function betOn(wallet: { walletId: string; playerId: string }) {
    const bet = command(wallet);
    await world.useCase.execute(bet);
    return bet.externalTransactionId;
  }

  test("a ROLLBACK uses the reference up for a later REFUND, and the code says so", async () => {
    const wallet = await world.openWallet("100.00");
    const reference = await betOn(wallet);
    await world.useCase.execute(
      command(wallet, { kind: Kind.Rollback, referenceExternalTransactionId: reference }),
    );
    const refund = await world.useCase.execute(
      command(wallet, { kind: Kind.Refund, referenceExternalTransactionId: reference }),
    );
    expect(refund).toMatchObject({ status: Status.Rejected, failureCode: "ALREADY_REVERSED" });
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  test("a WIN is not a reversal, so the BET can still be refunded", async () => {
    const wallet = await world.openWallet("100.00");
    const reference = await betOn(wallet);
    await world.useCase.execute(
      command(wallet, { kind: Kind.Win, money: brl("5.00"), referenceExternalTransactionId: reference }),
    );
    const refund = await world.useCase.execute(
      command(wallet, { kind: Kind.Refund, referenceExternalTransactionId: reference }),
    );
    expect(refund.status).toBe(Status.Processed);
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  // FR-27: a refusal does not use the reference up.
  test("a ROLLBACK refused for funds can be sent again under a new id, and then applies", async () => {
    const wallet = await world.openWallet("10.00");
    const win = command(wallet, { kind: Kind.Win, money: brl("50.00") });
    await world.useCase.execute(win);
    await world.useCase.execute(command(wallet, { money: brl("55.00") }));
    const rollback = {
      kind: Kind.Rollback,
      money: brl("50.00"),
      referenceExternalTransactionId: win.externalTransactionId,
    };
    expect(await world.useCase.execute(command(wallet, rollback))).toMatchObject({
      failureCode: "REVERSAL_INSUFFICIENT_FUNDS",
    });
    await world.useCase.execute(command(wallet, { kind: Kind.Win, money: brl("100.00") }));
    const again = await world.useCase.execute(command(wallet, rollback));
    expect(again.status).toBe(Status.Processed);
    expect((await world.walletState(wallet.walletId)).balance).toBe("55.00");
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });
});

describe("a provider's ids are its own (FR-26)", () => {
  test("two providers may use one external id", async () => {
    const wallet = await world.openWallet("100.00");
    const external = randomUUID();
    await world.useCase.execute(command(wallet, { externalTransactionId: external, money: brl("1.00") }));
    const other = await world.useCase.execute(
      command(wallet, {
        providerId: "provider-b",
        externalTransactionId: external,
        idempotencyKey: `provider-b:${external}`,
        money: brl("2.00"),
      }),
    );
    expect(other).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    expect((await world.walletState(wallet.walletId)).balance).toBe("97.00");
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  test("a reversal cannot find another provider's transaction, so it waits", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet);
    await world.useCase.execute(bet);
    const refund = await world.useCase.execute(
      command(wallet, {
        providerId: "provider-b",
        kind: Kind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(refund.status).toBe(Status.PendingReference);
    expect((await world.walletState(wallet.walletId)).balance).toBe("20.00");
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });
});

describe("what stores nothing", () => {
  test("a wallet that does not exist", async () => {
    await expect(
      world.useCase.execute(command({ walletId: randomUUID(), playerId: randomUUID() })),
    ).rejects.toThrow(WalletNotFoundError);
  });

  test("an invalid command never reaches the database", async () => {
    const wallet = await world.openWallet("100.00");
    await expect(world.useCase.execute(command(wallet, { kind: Kind.Refund }))).rejects.toThrow(
      InvalidWagerTransactionError,
    );
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });
  });
});

describe("idempotency", () => {
  test("a replay returns the original result and changes nothing (FR-52)", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet);
    const original = await world.useCase.execute(bet);
    const before = await world.counts(wallet.walletId);
    const replay = await world.useCase.execute(bet);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(original.transactionId);
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
    expect(await world.counts(wallet.walletId)).toEqual(before);
  });

  // The balance as observed then, which is the done criterion: not the balance now.
  test("a replay returns the balance it saw, after the wallet has moved on", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet, { money: brl("10.00") });
    await world.useCase.execute(bet);
    await world.useCase.execute(command(wallet, { money: brl("30.00") }));
    expect((await world.walletState(wallet.walletId)).balance).toBe("60.00");
    await world.expectLedgerExplainsBalance(wallet.walletId);
    expect((await world.useCase.execute(bet)).balance?.toString()).toBe("90.00 BRL");
  });

  test("a rejection replays as the same rejection, even once the money is there (FR-57)", async () => {
    const wallet = await world.openWallet("10.00");
    const bet = command(wallet);
    await world.useCase.execute(bet);
    await world.useCase.execute(command(wallet, { kind: Kind.Win, money: brl("500.00") }));
    const replay = await world.useCase.execute(bet);
    expect(replay).toMatchObject({
      status: Status.Rejected,
      failureCode: "INSUFFICIENT_FUNDS",
      idempotentReplay: true,
    });
    expect(replay.balance?.toString()).toBe("10.00 BRL");
  });

  test("a waiting transaction replays as waiting (FR-56)", async () => {
    const wallet = await world.openWallet("100.00");
    const refund = command(wallet, { kind: Kind.Refund, referenceExternalTransactionId: "not-yet" });
    await world.useCase.execute(refund);
    expect(await world.useCase.execute(refund)).toMatchObject({
      status: Status.PendingReference,
      idempotentReplay: true,
    });
  });

  test("the same key with another payload is a conflict, not a replay (FR-53)", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet);
    await world.useCase.execute(bet);
    await expect(world.useCase.execute({ ...bet, money: brl("1.00") })).rejects.toThrow(
      IdempotencyConflictError,
    );
    expect((await world.walletState(wallet.walletId)).balance).toBe("20.00");
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  test("the same operation under another key is a conflict (FR-54)", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet);
    await world.useCase.execute(bet);
    await expect(world.useCase.execute({ ...bet, idempotencyKey: "another-key" })).rejects.toThrow(
      ExternalIdConflictError,
    );
  });

  test("transport fields do not make a replay a conflict: correlation ids differ on every delivery", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet);
    await world.useCase.execute(bet);
    expect(
      await world.useCase.execute({ ...bet, correlationId: randomUUID(), causationId: "msg-2" }),
    ).toMatchObject({ idempotentReplay: true });
  });
});

describe("a duplicate that wins between our two reads (found across three processes)", () => {
  // The lock-free check reads by key and then by the provider's id. Those are two reads, not one snapshot, so a
  // twin can commit in between: the first misses, the second finds the twin's row. That row has OUR key, so it is
  // a replay. It was reported as EXTERNAL_ID_CONFLICT, which says "another key": 13 of 600 identical requests, in 8
  // of 12 rounds of fifty spread over three processes. Here the twin is made to commit in exactly that gap.
  async function raceInTheGap(submitFirst: boolean) {
    const wallet = await world.openWallet("100.00");
    const request = command(wallet, { money: brl("10.00") });
    let twin: Promise<unknown> | undefined;
    const spied = instrumented(world.unitOfWork, async (call, phase) => {
      if (call === "transactions.findByKey" && phase === "after" && twin === undefined) {
        twin = world.useCase.execute(request);
        await twin;
      }
    });
    const result = await world.useCaseWith(spied).execute(request);
    return { wallet, result, twinRan: twin !== undefined, submitFirst };
  }

  test("it is a replay of the twin, not a conflict", async () => {
    const { wallet, result, twinRan } = await raceInTheGap(true);
    expect(twinRan).toBe(true);
    expect(result).toMatchObject({ status: Status.Processed, idempotentReplay: true });
    expect(result.balance?.toString()).toBe("90.00 BRL");
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  test("a twin with another payload but the same key is still a conflict on the key", async () => {
    const wallet = await world.openWallet("100.00");
    const original = command(wallet, { money: brl("10.00") });
    let twin: Promise<unknown> | undefined;
    const spied = instrumented(world.unitOfWork, async (call, phase) => {
      if (call === "transactions.findByKey" && phase === "after" && twin === undefined) {
        twin = world.useCase.execute({ ...original, money: brl("20.00") });
        await twin;
      }
    });
    await expect(world.useCaseWith(spied).execute(original)).rejects.toThrow(IdempotencyConflictError);
  });

  test("the same operation under another key is still a conflict on the id, in the same gap", async () => {
    const wallet = await world.openWallet("100.00");
    const original = command(wallet, { money: brl("10.00") });
    let twin: Promise<unknown> | undefined;
    const spied = instrumented(world.unitOfWork, async (call, phase) => {
      if (call === "transactions.findByKey" && phase === "after" && twin === undefined) {
        twin = world.useCase.execute({ ...original, idempotencyKey: "the-twins-own-key" });
        await twin;
      }
    });
    await expect(world.useCaseWith(spied).execute(original)).rejects.toThrow(ExternalIdConflictError);
  });
});

describe("atomicity: a failure after any write commits nothing (NFR-04)", () => {
  class Crash extends Error {}
  const scenarios: Array<
    [string, string[], (wallet: { walletId: string; playerId: string }) => ReturnType<typeof command>]
  > = [
    ["a BET", ["transactions.insert", "wallets.save", "ledger.append", "outbox.enqueue"], (w) => command(w)],
    ["a rejection", ["transactions.insert", "outbox.enqueue"], (w) => command(w, { money: brl("500.00") })],
    ["a LOSS", ["transactions.insert", "outbox.enqueue"], (w) => command(w, { kind: Kind.Loss })],
  ];

  for (const [name, writes, build] of scenarios) {
    test.each(writes)(`${name}: crash right after %s`, async (write) => {
      const wallet = await world.openWallet("100.00");
      let crashed = false;
      const failing = instrumented(world.unitOfWork, (call, phase) => {
        if (call === write && phase === "after") {
          crashed = true;
          throw new Crash();
        }
      });
      const operation = build(wallet);
      await expect(world.useCaseWith(failing).execute(operation)).rejects.toThrow(Crash);
      expect(crashed).toBe(true);
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });

      // And the same operation then applies exactly once: the failure left nothing in its way.
      const retry = await world.useCase.execute(operation);
      expect(retry.idempotentReplay).toBe(false);
      await world.expectLedgerExplainsBalance(wallet.walletId);
    });
  }
});

describe("order (ADR-0003)", () => {
  test("the wallet lock comes before every write, and the key is checked again under it", async () => {
    const wallet = await world.openWallet("100.00");
    const calls: string[] = [];
    const spy = instrumented(world.unitOfWork, (call, phase) => {
      if (phase === "before") calls.push(call);
    });
    await world.useCaseWith(spy).execute(command(wallet));
    const lock = calls.indexOf("wallets.lockById");
    const firstWrite = calls.findIndex((call) => /insert|save|append|enqueue/.test(call));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(firstWrite);
    expect(calls.slice(lock + 1, firstWrite)).toContain("transactions.findByKey");
    expect(calls.slice(0, lock)).toContain("transactions.findByKey");
  });

  // Duplicates must not queue behind real work on a busy wallet.
  test("a replay takes no lock at all", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet);
    await world.useCase.execute(bet);
    const calls: string[] = [];
    const spy = instrumented(world.unitOfWork, (call) => {
      calls.push(call);
    });
    await world.useCaseWith(spy).execute(bet);
    expect(calls).not.toContain("wallets.lockById");
    expect(calls).toContain("transactions.findByKey");
  });
});

describe("locks are transient failures, and commit nothing", () => {
  test("55P03: a lock that does not come within the timeout", async () => {
    const impatient = new MikroOrmUnitOfWork(world.orm, world.clock, {
      lockTimeoutMs: 50,
      statementTimeoutMs: 5_000,
    });
    const wallet = await world.openWallet("100.00");
    const held = deferred();
    const release = deferred();
    const holder = world.unitOfWork.run(async (tx) => {
      await tx.wallets.lockById(wallet.walletId);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const bet = command(wallet);
    const failure = await world
      .useCaseWith(impatient)
      .execute(bet)
      .catch((error: unknown) => error);
    release.resolve();
    await holder;
    expect(failure).toBeInstanceOf(TransientFailureError);
    expect(String(failure)).toContain("55P03");
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });
    // Trying again works, which is what transient promises.
    expect((await world.useCase.execute(bet)).status).toBe(Status.Processed);
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  // The designed order prevents this, so the test builds one on purpose: two wallets locked in opposite orders.
  test("40P01: a deadlock becomes a retry and not a 500", async () => {
    const a = await world.openWallet("100.00");
    const b = await world.openWallet("100.00");
    const bothHoldOne = { count: 0, ready: deferred() };
    const lockBoth = (first: string, second: string) =>
      world.unitOfWork.run(async (tx) => {
        await tx.wallets.lockById(first);
        if (++bothHoldOne.count === 2) bothHoldOne.ready.resolve();
        await bothHoldOne.ready.promise;
        await tx.wallets.lockById(second);
      });
    const results = await Promise.allSettled([
      lockBoth(a.walletId, b.walletId),
      lockBoth(b.walletId, a.walletId),
    ]);
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(TransientFailureError);
    expect(String(rejected[0]?.reason)).toContain("40P01");
  });

  test("57014: a statement over its time limit", async () => {
    const em = world.orm.em.fork();
    const failure = await em
      .transactional(async (tx) => {
        const connection = tx.getConnection();
        await connection.execute(
          "set local statement_timeout = '20ms'",
          [],
          "run",
          tx.getTransactionContext(),
        );
        await connection.execute("select pg_sleep(1)", [], "all", tx.getTransactionContext());
      })
      .catch((error: unknown) => classifyPersistenceError(error));
    expect(failure).toBeInstanceOf(TransientFailureError);
    expect(String(failure)).toContain("57014");
  });

  test("the limits end with the transaction, and do not leak to the connection's next user", async () => {
    const impatient = new MikroOrmUnitOfWork(world.orm, world.clock, {
      lockTimeoutMs: 50,
      statementTimeoutMs: 5_000,
    });
    await impatient.run(async (tx) => {
      await tx.transactions.findByKey("nothing");
    });
    const rows = await Promise.all(Array.from({ length: 12 }, () => world.sql("show lock_timeout")));
    for (const row of rows) expect(row[0]?.lock_timeout).toBe("0");
  });

  // Only the two operation keys mean "restart and find the winner". Anything else restarted would hide a bug.
  test("a unique violation on anything else stays loud, and is not read as a duplicate operation", async () => {
    const row = ["wager-consumer", randomUUID(), "a".repeat(64)];
    const insert =
      "insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, now())";
    await world.sql(insert, row);
    const failure = await world.sql(insert, row).catch((error: unknown) => classifyPersistenceError(error));
    expect(failure).not.toBeInstanceOf(DuplicateOperationError);
    expect(failure).not.toBeInstanceOf(WalletAlreadyExistsError);
    expect(String(failure)).toContain("pk_inbox_messages");
  });

  test("a constraint violation is not transient: retrying cannot change its answer", async () => {
    const failure = await world
      .sql(
        "insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, 'BRL', -1, 1, now(), now())",
        [randomUUID(), randomUUID()],
      )
      .catch((error: unknown) => classifyPersistenceError(error));
    expect(failure).not.toBeInstanceOf(TransientFailureError);
    expect(String(failure)).toContain("ck_wallets_balance_non_negative");
  });
});

describe("a full connection pool is transient too (NFR-11)", () => {
  // pg-pool reports it as a bare Error with no code, so the classifier goes by its message. This provokes the real
  // error, so an upgrade that rewords it fails here and not silently in production.
  test("the real error is recognised, and a request ends instead of waiting", async () => {
    const small = await SettlementWorld.create(
      { lockTimeoutMs: 2_000, statementTimeoutMs: 5_000 },
      { max: 2, acquireTimeoutMs: 150 },
    );
    const release = deferred();
    try {
      const wallet = await small.openWallet("100.00");
      const held = [deferred(), deferred()];
      const holders = held.map((signal) =>
        small.unitOfWork.run(async (tx) => {
          await tx.transactions.findByKey("nothing");
          signal.resolve();
          await release.promise;
        }),
      );
      await Promise.all(held.map((signal) => signal.promise));

      const raw = await small.orm.em
        .fork()
        .transactional(async () => undefined)
        .catch((error: unknown) => error);
      expect(String((raw as Error).message)).toContain(POOL_TIMEOUT_MESSAGE);

      const started = performance.now();
      const bet = command(wallet);
      const failure = await small.useCase.execute(bet).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TransientFailureError);
      expect(String((failure as Error).message)).toContain("no database connection");
      expect(performance.now() - started).toBeLessThan(1_000);

      // Nothing was committed, and once connections are free the same request goes through.
      release.resolve();
      await Promise.all(holders);
      expect(await small.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });
      expect((await small.useCase.execute(bet)).status).toBe(Status.Processed);
      await small.expectLedgerExplainsBalance(wallet.walletId);
    } finally {
      release.resolve();
      await small.destroy();
    }
  });
});

describe("a database that accepts the connection and never answers is transient", () => {
  // Found by the failure suite on a slow CI runner: opening a new connection took longer than the connection timeout,
  // and the client reports that as a bare Error ("Connection terminated due to connection timeout") with no code. It
  // was not recognised, so it was a 500 that no provider would retry. A server that accepts and stays silent
  // provokes the real error on every machine.
  test("the real error is recognised, so HTTP answers 503 and not 500", async () => {
    const { MikroORM } = await import("@mikro-orm/postgresql");
    const { createOrmConfig } = await import("../../src/platform/database/mikro-orm.config");
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
    const orm = await MikroORM.init(
      createOrmConfig(`postgres://wagering:wagering@127.0.0.1:${silent.port}/wagering`, "migrations", [], {
        acquireTimeoutMs: 200,
      }),
    );
    try {
      const raw = await orm.em
        .fork()
        .transactional(async () => undefined)
        .catch((error: unknown) => error);
      expect(String((raw as Error).message)).toContain("Connection terminated");

      const seen: string[] = [];
      const away = new MikroOrmUnitOfWork(orm, world.clock, {
        lockTimeoutMs: 50,
        statementTimeoutMs: 50,
        onTransientFailure: (reason) => seen.push(reason),
      });
      const failure = await away.run(async () => undefined).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TransientFailureError);
      expect(seen).toEqual(["connection"]);
    } finally {
      await orm.close(true);
      silent.stop(true);
    }
  });
});

describe("an unreachable database is transient", () => {
  test("the connection failure is classified, so HTTP answers 503", async () => {
    const { MikroORM } = await import("@mikro-orm/postgresql");
    const { createOrmConfig } = await import("../../src/platform/database/mikro-orm.config");
    const orm = await MikroORM.init(createOrmConfig("postgres://wagering:wagering@localhost:1/wagering"));
    const unreachable = new MikroOrmUnitOfWork(orm, world.clock, {
      lockTimeoutMs: 50,
      statementTimeoutMs: 50,
    });
    await expect(unreachable.run(async () => undefined)).rejects.toThrow(TransientFailureError);
    await orm.close();
  });
});
