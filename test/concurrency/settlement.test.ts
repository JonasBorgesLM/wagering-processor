import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { IdempotencyConflictError } from "../../src/wagering/application/errors";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/wagering/domain/wager-transaction";
import { brl, command, deferred, instrumented, SettlementWorld } from "../support/settlement";

// Requirements: FR-22, FR-28, FR-29, NFR-03.

// Real connections doing real work at once. Where order matters, barriers decide it rather than sleeps,
// so a pass means the behaviour and not a lucky schedule. Separate processes are the failure suite's (#22).

let world: SettlementWorld;
beforeAll(async () => {
  world = await SettlementWorld.create();
});
afterAll(() => world.destroy());

describe("the mandatory scenario (§8)", () => {
  test("100.00 and two bets of 80.00: one processed, one rejected, 20.00 left, one debit", async () => {
    const wallet = await world.openWallet("100.00");
    const results = await Promise.all([
      world.useCase.execute(command(wallet)),
      world.useCase.execute(command(wallet)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find((r) => r.status === Status.Rejected)?.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    expect((await world.counts(wallet.walletId)).entries).toBe(1);
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  test("retrying both changes nothing: no retry duplicates the debit", async () => {
    const wallet = await world.openWallet("100.00");
    const bets = [command(wallet), command(wallet)];
    const first = await Promise.all(bets.map((bet) => world.useCase.execute(bet)));
    const again = await Promise.all(bets.map((bet) => world.useCase.execute(bet)));
    expect(again.map((r) => r.status)).toEqual(first.map((r) => r.status));
    expect(again.every((r) => r.idempotentReplay)).toBe(true);
    expect((await world.walletState(wallet.walletId)).balance).toBe("20.00");
    await world.expectLedgerExplainsBalance(wallet.walletId);
    expect((await world.counts(wallet.walletId)).entries).toBe(1);
  });
});

describe("the same bet 50 times in parallel (§13)", () => {
  test("one debit, one row, the same transaction in every answer", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet, { money: brl("1.00") });
    const results = await Promise.all(Array.from({ length: 50 }, () => world.useCase.execute(bet)));
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.balance?.toString() === "99.00 BRL")).toBe(true);
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "99.00", version: 2 });
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });
});

describe("many operations on one wallet", () => {
  test("nothing is lost: the balance is exact, and every version is used once", async () => {
    const wallet = await world.openWallet("1000.00");
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        world.useCase.execute(command(wallet, { money: brl(`${i + 1}.01`) })),
      ),
    );
    const applied = results.filter((r) => r.status === Status.Processed);
    expect(applied.length + results.filter((r) => r.failureCode === "INSUFFICIENT_FUNDS").length).toBe(40);
    const { version } = await world.walletState(wallet.walletId);
    expect(version).toBe(applied.length + 1);
    expect((await world.counts(wallet.walletId)).entries).toBe(applied.length);
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });
});

describe("the unit of concurrency is the wallet (§8)", () => {
  async function holdLock(walletId: string) {
    const held = deferred();
    const release = deferred();
    const holder = world.unitOfWork.run(async (tx) => {
      await tx.wallets.lockById(walletId);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    return async () => {
      release.resolve();
      await holder;
    };
  }

  test("an operation on a locked wallet waits for the lock", async () => {
    const wallet = await world.openWallet("100.00");
    const release = await holdLock(wallet.walletId);
    const reachedLock = deferred();
    const settled = { done: false };
    const spy = instrumented(world.unitOfWork, (call, phase) => {
      if (call === "wallets.lockById" && phase === "before") reachedLock.resolve();
    });
    const pending = world
      .useCaseWith(spy)
      .execute(command(wallet))
      .then((result) => {
        settled.done = true;
        return result;
      });
    await reachedLock.promise;
    // Reaching the lock call is not waiting on it, so ask PostgreSQL: a backend must be blocked on a row lock.
    let blocked = 0;
    for (let i = 0; i < 200 && blocked === 0; i++) {
      const rows = await world.sql(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0",
      );
      blocked = rows[0]?.n as number;
      if (blocked === 0) await Bun.sleep(10);
    }
    expect(blocked).toBe(1);
    expect(settled.done).toBe(false);
    await release();
    expect((await pending).status).toBe(Status.Processed);
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });

  // Why there is no global lock (§5.6): the other wallet finishes while the first is still held.
  test("another wallet proceeds while one is locked", async () => {
    const busy = await world.openWallet("100.00");
    const free = await world.openWallet("100.00");
    const release = await holdLock(busy.walletId);
    const result = await world.useCase.execute(command(free));
    expect(result.status).toBe(Status.Processed);
    await release();
    await world.expectLedgerExplainsBalance(free.walletId);
  });

  test("wallets in parallel each end correct", async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => world.openWallet("100.00")));
    await Promise.all(
      wallets.flatMap((w) => [world.useCase.execute(command(w)), world.useCase.execute(command(w))]),
    );
    for (const wallet of wallets) {
      expect((await world.walletState(wallet.walletId)).balance).toBe("20.00");
      await world.expectLedgerExplainsBalance(wallet.walletId);
    }
  });
});

describe("one bet reversed many times at once (FR-22, FR-29, ADR-0006)", () => {
  test("twenty refunds and rollbacks: one applies, the rest are ALREADY_REVERSED, the stake returns once", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet, { money: brl("80.00") });
    await world.useCase.execute(bet);

    const reversals = Array.from({ length: 20 }, (_, i) =>
      command(wallet, {
        kind: i % 2 === 0 ? Kind.Refund : Kind.Rollback,
        money: brl("80.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    const results = await Promise.all(reversals.map((reversal) => world.useCase.execute(reversal)));

    expect(results.filter((result) => result.status === Status.Processed)).toHaveLength(1);
    const refused = results.filter((result) => result.status === Status.Rejected);
    expect(refused).toHaveLength(19);
    expect(refused.every((result) => result.failureCode === "ALREADY_REVERSED")).toBe(true);
    // 100 - 80 + 80, once. A second credit would show as 180.00.
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 3 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });
});

describe("reversals do not cascade (FR-28)", () => {
  test("reversing a bet leaves its win, and rolling back the refund does not make the bet reversible again", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet, { money: brl("80.00") });
    await world.useCase.execute(bet);
    const win = command(wallet, {
      kind: Kind.Win,
      money: brl("10.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await world.useCase.execute(win);

    const refund = command(wallet, {
      kind: Kind.Refund,
      money: brl("80.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await world.useCase.execute(refund)).status).toBe(Status.Processed);
    // 100 - 80 + 10 (win, still there) + 80 (refund)
    expect((await world.walletState(wallet.walletId)).balance).toBe("110.00");

    const undoRefund = command(wallet, {
      kind: Kind.Rollback,
      money: brl("80.00"),
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    expect((await world.useCase.execute(undoRefund)).status).toBe(Status.Processed);
    expect((await world.walletState(wallet.walletId)).balance).toBe("30.00");

    const again = await world.useCase.execute(
      command(wallet, {
        kind: Kind.Refund,
        money: brl("80.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(again).toMatchObject({ status: Status.Rejected, failureCode: "ALREADY_REVERSED" });
    expect((await world.walletState(wallet.walletId)).balance).toBe("30.00");
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });
});

describe("a race the wallet lock cannot serialize", () => {
  // One key claimed against two wallets: each holds its own lock, so only the unique index decides.
  test("the loser starts over, finds the winner, and reports a conflict", async () => {
    const a = await world.openWallet("100.00");
    const b = await world.openWallet("100.00");
    const external = randomUUID();
    const pastChecks = deferred();
    const winnerDone = deferred();
    const slow = instrumented(world.unitOfWork, async (call, phase) => {
      if (call === "transactions.insert" && phase === "before") {
        pastChecks.resolve();
        await winnerDone.promise;
      }
    });
    let attempts = 0;
    const counting = instrumented(slow, (call, phase) => {
      if (call === "wallets.lockById" && phase === "before") attempts++;
    });
    const loser = world
      .useCaseWith(counting)
      .execute(command(a, { externalTransactionId: external, money: brl("1.00") }))
      .catch((error: unknown) => error);
    await pastChecks.promise;
    const winner = await world.useCase.execute(
      command(b, { externalTransactionId: external, money: brl("2.00") }),
    );
    winnerDone.resolve();
    const outcome = await loser;

    expect(winner.status).toBe(Status.Processed);
    expect(outcome).toBeInstanceOf(IdempotencyConflictError);
    expect(attempts).toBe(1);
    expect(await world.walletState(a.walletId)).toEqual({ balance: "100.00", version: 1 });
    expect((await world.walletState(b.walletId)).balance).toBe("98.00");
    await world.expectLedgerExplainsBalance(a.walletId);
    await world.expectLedgerExplainsBalance(b.walletId);
  });
});
