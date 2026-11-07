import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TransientFailureError } from "../../src/wagering/application/errors";
import type { PendingReferenceStore, UnitOfWork } from "../../src/wagering/application/ports";
import { SettleWaitingReferences } from "../../src/wagering/application/settle-waiting-references";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/wagering/domain/wager-transaction";
import { MikroOrmPendingReferenceStore } from "../../src/wagering/infrastructure/persistence/mikro-orm-pending-reference-store";
import { eventually } from "../support/consumer-harness";
import { TEST_ENV } from "../support/env";
import { freePort } from "../support/ports";
import { brl, command, instrumented, SettlementWorld } from "../support/settlement";

// Requirements: FR-40 to FR-48.
// Out-of-order references (FR-40 to FR-43, section 7.1), on a real database with real parallel workers.

setDefaultTimeout(30_000);

let world: SettlementWorld;
const running: Bun.Subprocess[] = [];
beforeAll(async () => {
  world = await SettlementWorld.create();
});
afterAll(() => world.destroy());
afterEach(async () => {
  for (const child of running.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
});

const TTL_MS = 60 * 60 * 1000;
const realStore = () => new MikroOrmPendingReferenceStore(world.orm, world.options);

function workerOver(
  options: { unitOfWork?: UnitOfWork; store?: PendingReferenceStore; batchSize?: number } = {},
) {
  return new SettleWaitingReferences(
    options.store ?? realStore(),
    options.unitOfWork ?? world.unitOfWork,
    world.clock,
    world.ids,
    {
      batchSize: options.batchSize ?? 25,
      leaseMs: 1_000,
      ttlMs: TTL_MS,
      retryDelayMs: () => 60_000,
    },
  );
}

const makeDue = (id: string) =>
  world.sql("update wager_transactions set next_retry_at = now() - interval '1 second' where id = ?", [id]);
const age = (id: string, hours: number) =>
  world.sql("update wager_transactions set created_at = now() - make_interval(hours => ?) where id = ?", [
    hours,
    id,
  ]);

async function rowOf(id: string) {
  const [row] = await world.sql(
    "select status, failure_code, retry_attempts, next_retry_at, processed_at, reference_transaction_id, observed_balance::text as observed from wager_transactions where id = ?",
    [id],
  );
  return row as {
    status: string;
    failure_code: string | null;
    retry_attempts: number;
    next_retry_at: Date | null;
    processed_at: Date | null;
    reference_transaction_id: string | null;
    observed: string | null;
  };
}

const eventTypes = async (walletId: string) =>
  (
    await world.sql(
      "select event_type from outbox_messages where aggregate_id = ? order by occurred_at, id",
      [walletId],
    )
  ).map((row) => row.event_type as string);

/** A bet, built but not sent: so a test chooses whether a reversal arrives before it or after. */
function aBet(wallet: { walletId: string; playerId: string }) {
  return command(wallet, { money: brl("80.00") });
}
function reversalOf(
  wallet: { walletId: string; playerId: string },
  kind: Kind.Refund | Kind.Rollback,
  referenceExternalTransactionId: string,
) {
  return command(wallet, { kind, money: brl("80.00"), referenceExternalTransactionId });
}

describe("the worker does not wait for rows another one is claiming (FR-45)", () => {
  // Like the outbox's claim: without SKIP LOCKED the lease would still keep two workers off one row, because the
  // second re-reads it after the wait. What SKIP LOCKED buys is that it does not wait (the mutation run found that
  // nothing noticed it gone).
  test("a claim over rows another transaction holds returns the rest at once", async () => {
    const waiting: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const wallet = await world.openWallet("100.00");
      const reversal = await world.useCase.execute(
        reversalOf(wallet, Kind.Refund, aBet(wallet).externalTransactionId),
      );
      await makeDue(reversal.transactionId);
      waiting.push(reversal.transactionId);
    }
    const heldId = waiting[0] as string;

    let holding!: () => void;
    const isHeld = new Promise<void>((resolve) => {
      holding = resolve;
    });
    let release!: () => void;
    const mayRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = world.orm.em.transactional(async (em) => {
      await em
        .getConnection()
        .execute(
          "select id from wager_transactions where id = ? for update",
          [heldId],
          "all",
          em.getTransactionContext(),
        );
      holding();
      await mayRelease;
    });
    try {
      await isHeld;
      const started = performance.now();
      const claimed = await realStore().claimDue(100, 60_000, new Date());
      const took = performance.now() - started;
      const ids = claimed.map((row) => row.id);
      expect(ids).not.toContain(heldId);
      expect(ids).toContain(waiting[1] as string);
      expect(ids).toContain(waiting[2] as string);
      expect(took).toBeLessThan(1_000);
    } finally {
      release();
      await holder;
      // Later tests assume nothing else is due.
      await world.sql(
        "update wager_transactions set next_retry_at = now() + interval '1 day' where id = any(?::uuid[])",
        [`{${waiting.join(",")}}`],
      );
    }
  });
});

describe("a reversal that arrives before its bet (section 7.1)", () => {
  test.each([Kind.Refund, Kind.Rollback] as const)(
    "a %s waits, is looked at again, and settles once the bet is there",
    async (kind) => {
      const wallet = await world.openWallet("100.00");
      const bet = aBet(wallet);
      const reversal = await world.useCase.execute(reversalOf(wallet, kind, bet.externalTransactionId));

      // Arrived first: waiting, scheduled, announced once, nothing moved.
      expect(reversal.status).toBe(Status.PendingReference);
      const waiting = await rowOf(reversal.transactionId);
      expect(waiting.next_retry_at).not.toBeNull();
      expect(await eventTypes(wallet.walletId)).toEqual(["WagerTransactionPendingReference"]);

      // Looked at while the bet is still missing: it keeps waiting and says nothing more.
      await makeDue(reversal.transactionId);
      expect(await workerOver().runOnce()).toMatchObject({ claimed: 1, waiting: 1, settled: 0 });
      const stillWaiting = await rowOf(reversal.transactionId);
      expect(stillWaiting.status).toBe("PENDING_REFERENCE");
      expect(stillWaiting.retry_attempts).toBe(1);
      expect(new Date(stillWaiting.next_retry_at as Date).getTime()).toBeGreaterThan(Date.now() + 30_000);
      expect(await eventTypes(wallet.walletId)).toEqual(["WagerTransactionPendingReference"]);
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });

      // The bet arrives, and the next look settles the reversal.
      await world.useCase.execute(bet);
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
      await makeDue(reversal.transactionId);
      expect(await workerOver().runOnce()).toMatchObject({ claimed: 1, settled: 1 });

      const settled = await rowOf(reversal.transactionId);
      expect(settled).toMatchObject({ status: "PROCESSED", failure_code: null, next_retry_at: null });
      expect(settled.processed_at).not.toBeNull();
      expect(settled.reference_transaction_id).not.toBeNull();
      // Both kinds undo the bet: the refund returns its debit, and so does a rollback of a bet.
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 3 });
      expect(await eventTypes(wallet.walletId)).toEqual([
        "WagerTransactionPendingReference",
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
      await world.expectLedgerExplainsBalance(wallet.walletId);

      // Done: it is not looked at again.
      expect(await workerOver().runOnce()).toMatchObject({ claimed: 0 });
    },
  );

  test("the balance is checked when it settles, not when it arrived (FR-43)", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = aBet(wallet);
    // A ROLLBACK of a WIN takes money back; the wallet cannot cover it when it is looked at.
    const win = command(wallet, { kind: Kind.Win, money: brl("500.00") });
    const rollback = await world.useCase.execute(
      command(wallet, {
        kind: Kind.Rollback,
        money: brl("500.00"),
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect(rollback.status).toBe(Status.PendingReference);
    await world.useCase.execute(win);
    await world.useCase.execute(bet); // 600 - 80 = 520, then spend most of it
    await world.useCase.execute(command(wallet, { money: brl("500.00") }));
    await makeDue(rollback.transactionId);
    expect(await workerOver().runOnce()).toMatchObject({ claimed: 1, rejected: 1 });
    expect(await rowOf(rollback.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REVERSAL_INSUFFICIENT_FUNDS",
    });
  });
});

describe("a reversal waiting on another reversal (section 7.1, known failure mode)", () => {
  test("keeps waiting while the first does, and both settle in order once the bet arrives", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = aBet(wallet);
    const refund = reversalOf(wallet, Kind.Refund, bet.externalTransactionId);
    const rollbackOfRefund = reversalOf(wallet, Kind.Rollback, refund.externalTransactionId);

    const first = await world.useCase.execute(refund);
    // Arrives while its reference is itself only waiting: it waits too, and is not rejected.
    const second = await world.useCase.execute(rollbackOfRefund);
    expect([first.status, second.status]).toEqual([Status.PendingReference, Status.PendingReference]);

    await Promise.all([makeDue(first.transactionId), makeDue(second.transactionId)]);
    expect(await workerOver().runOnce()).toMatchObject({ claimed: 2, waiting: 2, rejected: 0 });
    expect((await rowOf(second.transactionId)).status).toBe("PENDING_REFERENCE");

    await world.useCase.execute(bet);
    await Promise.all([makeDue(first.transactionId), makeDue(second.transactionId)]);
    // One round: the older settles first, so the younger finds it processed.
    expect(await workerOver().runOnce()).toMatchObject({ claimed: 2, settled: 2 });

    expect((await rowOf(first.transactionId)).status).toBe("PROCESSED");
    expect((await rowOf(second.transactionId)).status).toBe("PROCESSED");
    // 100 - 80 (bet) + 80 (refund) - 80 (the refund rolled back)
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 4 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });
});

describe("a reference that never arrives (FR-41, FR-42)", () => {
  test("after the TTL the reversal is rejected with REFERENCE_NOT_FOUND, and an event says so", async () => {
    const wallet = await world.openWallet("100.00");
    const reversal = await world.useCase.execute(reversalOf(wallet, Kind.Rollback, "never-comes"));
    await age(reversal.transactionId, 2);
    await makeDue(reversal.transactionId);

    expect(await workerOver().runOnce()).toMatchObject({ claimed: 1, expired: 1 });

    expect(await rowOf(reversal.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
      next_retry_at: null,
    });
    expect(await eventTypes(wallet.walletId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });
    expect(await workerOver().runOnce()).toMatchObject({ claimed: 0 });
  });

  test("before the TTL it is not rejected", async () => {
    const wallet = await world.openWallet("100.00");
    const reversal = await world.useCase.execute(reversalOf(wallet, Kind.Rollback, "not-yet"));
    await age(reversal.transactionId, 0);
    await makeDue(reversal.transactionId);
    expect(await workerOver().runOnce()).toMatchObject({ waiting: 1, expired: 0 });
  });

  test("a reference that arrived after the TTL but before the look still settles it", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = aBet(wallet);
    const reversal = await world.useCase.execute(reversalOf(wallet, Kind.Refund, bet.externalTransactionId));
    await world.useCase.execute(bet);
    await age(reversal.transactionId, 2);
    await makeDue(reversal.transactionId);
    expect(await workerOver().runOnce()).toMatchObject({ settled: 1, expired: 0 });
    expect((await rowOf(reversal.transactionId)).status).toBe("PROCESSED");
  });

  test("a bet that arrives after the reversal expired is applied normally: there is no tombstone", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = aBet(wallet);
    const reversal = await world.useCase.execute(
      reversalOf(wallet, Kind.Rollback, bet.externalTransactionId),
    );
    await age(reversal.transactionId, 2);
    await makeDue(reversal.transactionId);
    await workerOver().runOnce();
    expect((await world.useCase.execute(bet)).status).toBe(Status.Processed);
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
  });
});

describe("several workers", () => {
  test("never claim or settle the same transaction twice", async () => {
    const wallets = await Promise.all(Array.from({ length: 60 }, () => world.openWallet("100.00")));
    const waiting: string[] = [];
    for (const wallet of wallets) {
      const bet = aBet(wallet);
      // The reversal arrives first, and the bet right behind it.
      const refund = await world.useCase.execute(reversalOf(wallet, Kind.Refund, bet.externalTransactionId));
      waiting.push(refund.transactionId);
      await world.useCase.execute(bet);
    }
    await Promise.all(waiting.map(makeDue));

    const claims = new Map<string, number>();
    const recording: PendingReferenceStore = {
      claimDue: async (...args) => {
        const claimed = await realStore().claimDue(...args);
        for (const row of claimed) claims.set(row.id, (claims.get(row.id) ?? 0) + 1);
        return claimed;
      },
    };
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let idle = 0; idle < 2; ) {
          const { claimed } = await workerOver({ store: recording, batchSize: 5 }).runOnce();
          idle = claimed === 0 ? idle + 1 : 0;
        }
      }),
    );

    expect(claims.size).toBe(waiting.length);
    expect([...claims.values()].every((count) => count === 1)).toBe(true);
    for (const [index, wallet] of wallets.entries()) {
      expect((await rowOf(waiting[index] as string)).status).toBe("PROCESSED");
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 3 });
      expect(
        (await eventTypes(wallet.walletId)).filter((type) => type === "WagerTransactionProcessed"),
      ).toHaveLength(2);
    }
  }, 60_000);

  test("a transaction another worker settled between the claim and the lock is skipped", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = aBet(wallet);
    const reversal = await world.useCase.execute(reversalOf(wallet, Kind.Refund, bet.externalTransactionId));
    await world.useCase.execute(bet);
    await makeDue(reversal.transactionId);

    // A store that hands out the same claim twice, as a lease that ran out and was taken again would.
    const real = realStore();
    const twice: PendingReferenceStore = {
      claimDue: async (...args) => {
        const claimed = await real.claimDue(...args);
        return [...claimed, ...claimed];
      },
    };
    expect(await workerOver({ store: twice }).runOnce()).toMatchObject({
      claimed: 2,
      settled: 1,
      skipped: 1,
    });
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 3 });
    expect(await eventTypes(wallet.walletId)).toHaveLength(5);
  });
});

describe("when settling goes wrong", () => {
  test("an infrastructure failure leaves it waiting, and it is tried again when the lease ends", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = aBet(wallet);
    const reversal = await world.useCase.execute(reversalOf(wallet, Kind.Refund, bet.externalTransactionId));
    await world.useCase.execute(bet);
    await makeDue(reversal.transactionId);

    const away = instrumented(world.unitOfWork, (call, phase) => {
      if (call === "wallets.lockById" && phase === "before") throw new TransientFailureError("database away");
    });
    expect(await workerOver({ unitOfWork: away }).runOnce()).toMatchObject({
      claimed: 1,
      transientFailures: 1,
      failed: 0,
    });
    const row = await rowOf(reversal.transactionId);
    expect(row.status).toBe("PENDING_REFERENCE");
    expect(row.retry_attempts).toBe(1);

    // Leased: nobody else takes it meanwhile.
    expect(await workerOver().runOnce()).toMatchObject({ claimed: 0 });
    await Bun.sleep(1_100);
    expect(await workerOver().runOnce()).toMatchObject({ claimed: 1, settled: 1 });
    expect((await rowOf(reversal.transactionId)).retry_attempts).toBe(2);
  });

  test("a failure retrying cannot change makes it FAILED (FR-32), and nothing else of it is applied", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = aBet(wallet);
    const reversal = await world.useCase.execute(reversalOf(wallet, Kind.Refund, bet.externalTransactionId));
    await world.useCase.execute(bet);
    await makeDue(reversal.transactionId);

    let updates = 0;
    const broken = instrumented(world.unitOfWork, (call, phase) => {
      // The first update is the settlement and the second is recording the failure.
      if (call === "transactions.update" && phase === "before" && ++updates === 1) throw new Error("a bug");
    });
    const result = await workerOver({ unitOfWork: broken }).runOnce();
    expect(result).toMatchObject({ claimed: 1, failed: 1 });
    expect(String(result.errors[0])).toContain("a bug");

    expect(await rowOf(reversal.transactionId)).toMatchObject({
      status: "FAILED",
      failure_code: "SETTLEMENT_FAILED",
      next_retry_at: null,
    });
    // The wallet was not touched by the attempt that failed.
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
    expect(await workerOver().runOnce()).toMatchObject({ claimed: 0 });
  });

  test("only a waiting transaction that is due is claimed", async () => {
    const wallet = await world.openWallet("100.00");
    const notDue = await world.useCase.execute(reversalOf(wallet, Kind.Rollback, "later"));
    await world.sql("update wager_transactions set next_retry_at = now() + interval '1 hour' where id = ?", [
      notDue.transactionId,
    ]);
    const plain = await world.useCase.execute(aBet(wallet));
    expect(plain.status).toBe(Status.Processed);
    expect(await workerOver().runOnce()).toMatchObject({ claimed: 0 });
  });
});

describe("the schedule belongs to the wait (schema)", () => {
  test("a transaction that is no longer waiting cannot keep one", async () => {
    const wallet = await world.openWallet("100.00");
    const reversal = await world.useCase.execute(reversalOf(wallet, Kind.Rollback, "x"));
    await expect(
      world.sql(
        "update wager_transactions set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND' where id = ?",
        [reversal.transactionId],
      ),
    ).rejects.toThrow("ck_wager_transactions_retry_only_while_waiting");
  });
});

describe("as a process (FR-81)", () => {
  test("the reference-worker role settles what is due, and SIGTERM stops it cleanly", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = aBet(wallet);
    const reversal = await world.useCase.execute(reversalOf(wallet, Kind.Refund, bet.externalTransactionId));
    await world.useCase.execute(bet);
    await makeDue(reversal.transactionId);

    const child = Bun.spawn(["bun", "run", "src/main.ts"], {
      env: {
        ...process.env,
        ...TEST_ENV,
        DATABASE_URL: world.databaseUrl(),
        PORT: String(freePort()),
        APP_ROLES: "reference-worker",
        REFERENCE_POLL_INTERVAL_MS: "100",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    running.push(child);
    await eventually(
      async () => (await rowOf(reversal.transactionId)).status === Status.Processed,
      "the process to settle it",
      15_000,
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await new Response(child.stdout as ReadableStream).text()).toContain("Draining");
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 3 });
  }, 40_000);
});
