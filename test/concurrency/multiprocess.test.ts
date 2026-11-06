import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";
import { WagerTransactionKind as Kind } from "../../src/wagering/domain/wager-transaction";
import { BrokerProxy } from "../support/broker-proxy";
import { Cluster, type ClusterProcess } from "../support/cluster";
import {
  drainEvents,
  eventually,
  inputUrl,
  message,
  purge,
  purgeEvents,
  queueIsEmpty,
  send,
  setUpEventsQueue,
  setUpQueues,
  sqs,
} from "../support/consumer-harness";
import { call, type Reply } from "../support/http";
import { brl, command, SettlementWorld } from "../support/settlement";

// Requirements: NFR-03, NFR-07, FR-29, FR-40, FR-80, FR-81, FR-90, FR-95; challenge section 13.
// The mandatory concurrency scenarios of section 13, with real processes: several applications sharing one database
// and one broker, killed and restarted. In-process tests cannot show a kill, a restart or a second instance taking
// over, which is what these are for.
//
// Nothing here sleeps and hopes. Where order matters, the test holds a lock, holds a request at a proxy, or waits
// for a state to appear, and only then acts. Every test ends on the invariant of section 13: the stored balance
// equals the balance the ledger rebuilds, and is never negative.

setDefaultTimeout(180_000);

let world: SettlementWorld;
let cluster: Cluster;
beforeAll(async () => {
  await setUpQueues();
  await setUpEventsQueue();
  world = await SettlementWorld.create();
  cluster = new Cluster(world);
});
afterAll(async () => {
  await cluster.stopAll();
  await purge();
  await purgeEvents();
  sqs.destroy();
  await world.destroy();
});
afterEach(async () => {
  await cluster.stopAll();
  // A killed process may leave a long poll open for one more wait.
  await Bun.sleep(1_200);
  await purge();
  await purgeEvents();
});

type Wallet = { walletId: string; playerId: string };
type Operation = ReturnType<typeof command>;

const bodyOf = (op: Operation) => ({
  providerId: op.providerId,
  externalTransactionId: op.externalTransactionId,
  playerId: op.playerId,
  walletId: op.walletId,
  roundId: op.roundId,
  gameId: op.gameId,
  kind: op.kind,
  money: op.money.toJSON(),
  ...(op.referenceExternalTransactionId
    ? { referenceExternalTransactionId: op.referenceExternalTransactionId }
    : {}),
});

/**
 * Sends the operation the way a provider must: a `503` means nothing was changed and the same request may be sent
 * again, so it is, with the same key. A busy machine answers some of ninety requests that way, and that is the
 * contract working, not a failure of the scenario. Anything else is returned as it came.
 */
async function submit(proc: ClusterProcess, op: Operation): Promise<Reply> {
  for (let attempt = 0; ; attempt++) {
    const reply = await call(`${proc.url}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": op.idempotencyKey },
      body: JSON.stringify(bodyOf(op)),
    });
    if (reply.status !== 503 || attempt >= 40) return reply;
    await Bun.sleep(250);
  }
}

/** The queue form of the same operation: the message carries the same fields and the key. */
const queueMessage = (wallet: Wallet, op: Operation, messageId = `msg-${randomUUID()}`) =>
  message(wallet, {
    messageId,
    providerId: op.providerId,
    externalTransactionId: op.externalTransactionId,
    idempotencyKey: op.idempotencyKey,
    roundId: op.roundId,
    gameId: op.gameId,
    kind: op.kind,
    money: op.money.toJSON(),
    ...(op.referenceExternalTransactionId
      ? { referenceExternalTransactionId: op.referenceExternalTransactionId }
      : {}),
  });

/** The invariant every test ends on (section 13): the balance is what the ledger rebuilds, and never negative. */
async function expectBooksBalance(wallets: Wallet[]) {
  for (const wallet of wallets) {
    await world.expectLedgerExplainsBalance(wallet.walletId);
    expect(Number((await world.walletState(wallet.walletId)).balance)).toBeGreaterThanOrEqual(0);
  }
}

/** What reached the events queue for these wallets. Rows of earlier tests that nobody had published yet are published
 * by these tests' publishers too, and they are not these tests' to judge. */
async function eventsOf(wallets: Wallet[]): Promise<string[]> {
  const mine = new Set(wallets.map((wallet) => wallet.walletId));
  return (await drainEvents()).filter((event) => mine.has(event.aggregateId)).map((event) => event.eventId);
}

/** The error lines the processes wrote, so a failure that says "500" can say why. */
const errorsOf = (processes: ClusterProcess[]): string[] =>
  processes.flatMap((proc) =>
    proc
      .output()
      .split("\n")
      .filter((line) => line.includes('"level":"error"') || line.includes('"level":"fatal"'))
      .map((line) => line.slice(0, 600)),
  );

const roundRobin = <T>(items: T[], index: number): T => items[index % items.length] as T;

/** The first column of the first row of a counting query. */
async function count(query: string, params: unknown[] = []): Promise<number> {
  return (await world.sql(query, params))[0]?.n as number;
}

async function allPublished(): Promise<boolean> {
  return (await count("select count(*)::int as n from outbox_messages where published_at is null")) === 0;
}

describe("1. the same bet 50 times at once, through three processes", () => {
  test("one debit, and every answer is the same transaction", async () => {
    const processes = await Promise.all([cluster.start("api"), cluster.start("api"), cluster.start("api")]);
    const wallet = await world.openWallet("100.00");
    const op = command(wallet, { money: brl("80.00") });

    const replies = await Promise.all(
      Array.from({ length: 50 }, (_, i) => submit(roundRobin(processes, i), op)),
    );
    const bodies = await Promise.all(replies.map((reply) => reply.json()));

    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    expect(bodies.filter((body) => body.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(bodies.map((body) => body.transactionId)).size).toBe(1);
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
    await expectBooksBalance([wallet]);
  });
});

describe("2. operations contending for one balance, through three processes", () => {
  test("100.00 and two bets of 80.00: one processed, one rejected, 20.00 left, one debit (section 8)", async () => {
    const processes = await Promise.all([cluster.start("api"), cluster.start("api"), cluster.start("api")]);
    const wallets: Wallet[] = [];
    for (let round = 0; round < 12; round++) {
      const wallet = await world.openWallet("100.00");
      wallets.push(wallet);
      const [first, second] = [command(wallet), command(wallet)];
      const replies = await Promise.all([
        submit(roundRobin(processes, round), first),
        submit(roundRobin(processes, round + 1), second),
      ]);
      const statuses = (await Promise.all(replies.map((reply) => reply.json())))
        .map((body) => body.status)
        .sort();
      expect(statuses, `round ${round}`).toEqual(["PROCESSED", "REJECTED"]);
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
      expect((await world.counts(wallet.walletId)).entries).toBe(1);

      // No retry duplicates the debit, through any process.
      for (const [index, op] of [first, second].entries())
        await submit(roundRobin(processes, round + index + 2), op);
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    }
    await expectBooksBalance(wallets);
  });

  test("thirty bets of 10.00 against 50.00: exactly five applied, none negative, the rest refused", async () => {
    const processes = await Promise.all([cluster.start("api"), cluster.start("api"), cluster.start("api")]);
    const wallet = await world.openWallet("50.00");
    const replies = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        submit(roundRobin(processes, i), command(wallet, { money: brl("10.00") })),
      ),
    );
    const bodies = await Promise.all(replies.map((reply) => reply.json()));
    expect(bodies.filter((body) => body.status === "PROCESSED")).toHaveLength(5);
    expect(bodies.filter((body) => body.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(25);
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "0.00", version: 6 });
    await expectBooksBalance([wallet]);
  });
});

describe("3. different wallets at once, through three processes", () => {
  test("each ends exactly right", async () => {
    const processes = await Promise.all([cluster.start("api"), cluster.start("api"), cluster.start("api")]);
    const wallets = await Promise.all(Array.from({ length: 30 }, () => world.openWallet("100.00")));
    const requests = wallets.flatMap((wallet) =>
      Array.from({ length: 3 }, () => command(wallet, { money: brl("10.00") })),
    );
    const replies = await Promise.all(requests.map((op, i) => submit(roundRobin(processes, i), op)));
    const seen = await Promise.all(
      replies.map(async (reply) => `${reply.status} ${JSON.stringify(await reply.json())}`),
    );
    expect({
      refused: seen.filter((answer) => !answer.startsWith("200 ")),
      logged: errorsOf(processes),
    }).toEqual({
      refused: [],
      logged: [],
    });
    for (const wallet of wallets) {
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "70.00", version: 4 });
    }
    await expectBooksBalance(wallets);
  });
});

describe("4. three processes doing everything at once", () => {
  test("HTTP, queue, duplicates and early reversals through processes that each run every role", async () => {
    const processes = await Promise.all(
      Array.from({ length: 3 }, () => cluster.start("api,consumer,publisher,reference-worker")),
    );
    const wallets = await Promise.all(Array.from({ length: 20 }, () => world.openWallet("100.00")));

    const work = wallets.map(async (wallet, index) => {
      const bet1 = command(wallet, { money: brl("10.00") });
      const win = command(wallet, { kind: Kind.Win, money: brl("5.00") });
      const bet2 = command(wallet, { money: brl("10.00") });
      const refund = command(wallet, {
        kind: Kind.Refund,
        money: brl("10.00"),
        referenceExternalTransactionId: bet2.externalTransactionId,
      });
      await Promise.all([
        // The refund arrives before the bet it reverses, over HTTP.
        submit(roundRobin(processes, index), refund),
        send(queueMessage(wallet, win), wallet.walletId),
        // The same bet over HTTP twice, through two processes, and the same message twice.
        submit(roundRobin(processes, index + 1), bet1),
        submit(roundRobin(processes, index + 2), bet1),
        send(queueMessage(wallet, win, `msg-dup-${randomUUID()}`), wallet.walletId),
      ]);
      await submit(roundRobin(processes, index), bet2);
    });
    await Promise.all(work);

    // 100 - 10 (bet1) + 5 (win) - 10 (bet2) + 10 (refund of bet2), each exactly once.
    await eventually(
      async () => {
        const rows = await world.sql(
          "select count(*)::int as n from wallets w where w.id = any(?::uuid[]) and w.balance = 95.00 and w.version = 5",
          [`{${wallets.map((wallet) => wallet.walletId).join(",")}}`],
        );
        return rows[0]?.n === wallets.length && (await allPublished());
      },
      "every wallet settled and every event published",
      90_000,
    );

    for (const wallet of wallets) {
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "95.00", version: 5 });
      expect((await world.counts(wallet.walletId)).transactions).toBe(4);
    }
    await expectBooksBalance(wallets);

    const outbox = await world.sql("select id from outbox_messages where aggregate_id = any(?::uuid[])", [
      `{${wallets.map((wallet) => wallet.walletId).join(",")}}`,
    ]);
    const published = new Set(await eventsOf(wallets));
    expect(new Set(outbox.map((row) => row.id as string))).toEqual(published);
  });
});

describe("5. a worker killed after the commit and before the acknowledgement", () => {
  test("the message is redelivered to another process and changes nothing", async () => {
    // The acknowledgement is held at the proxy, so the process has committed and cannot have acknowledged: that is
    // the state, found and not raced for.
    const proxy = BrokerProxy.start((request) => request.action === "DeleteMessage");
    try {
      const wallet = await world.openWallet("100.00");
      const victim = await cluster.start("consumer", { SQS_ENDPOINT: proxy.origin });
      await send(queueMessage(wallet, command(wallet, { money: brl("80.00") })), wallet.walletId);

      await eventually(() => proxy.heldCount("DeleteMessage") === 1, "the acknowledgement to be held");
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
      expect((await world.counts(wallet.walletId)).transactions).toBe(1);

      await victim.kill("SIGKILL");

      // The visibility timeout would return it in 30 s; the test returns it now, with the handle the dead process held.
      const handle = proxy.held.find((request) => request.action === "DeleteMessage")?.body
        .ReceiptHandle as string;
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: inputUrl,
          ReceiptHandle: handle,
          VisibilityTimeout: 0,
        }),
      );

      const survivors = await Promise.all([cluster.start("consumer"), cluster.start("consumer")]);
      await eventually(queueIsEmpty, "a surviving process to acknowledge the redelivery");

      expect(survivors.map((proc) => proc.output()).join("\n")).toContain("Message was a replay");
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
      await expectBooksBalance([wallet]);
    } finally {
      proxy.stop();
    }
  });
});

describe("6. publishers on the same outbox", () => {
  test("three publishers claim each row once, and every event arrives once", async () => {
    const wallets = await Promise.all(Array.from({ length: 60 }, () => world.openWallet("100.00")));
    for (const wallet of wallets) await world.useCase.execute(command(wallet, { money: brl("10.00") }));
    const ids = (
      await world.sql("select id from outbox_messages where aggregate_id = any(?::uuid[])", [
        `{${wallets.map((wallet) => wallet.walletId).join(",")}}`,
      ])
    ).map((row) => row.id as string);
    expect(ids).toHaveLength(120);

    await Promise.all(Array.from({ length: 3 }, () => cluster.start("publisher")));
    await eventually(allPublished, "the outbox to be published", 60_000);

    const n = await count(
      "select count(*)::int as n from outbox_messages where aggregate_id = any(?::uuid[]) and attempts <> 1",
      [`{${wallets.map((wallet) => wallet.walletId).join(",")}}`],
    );
    // A row claimed twice would have been published twice: one claim each means no two publishers took the same row.
    expect(n).toBe(0);
    const received = await eventsOf(wallets);
    expect(received).toHaveLength(120);
    expect(new Set(received)).toEqual(new Set(ids));
    await expectBooksBalance(wallets);
  });

  test("a publisher killed after claiming and before publishing: others take over and no event is lost", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => world.openWallet("100.00")));
    for (const wallet of wallets) await world.useCase.execute(command(wallet, { money: brl("10.00") }));
    const ids = (
      await world.sql("select id from outbox_messages where aggregate_id = any(?::uuid[])", [
        `{${wallets.map((wallet) => wallet.walletId).join(",")}}`,
      ])
    ).map((row) => row.id as string);

    // The publish is held at the proxy: the rows are claimed and nothing has been sent.
    const proxy = BrokerProxy.start((request) => request.action === "SendMessage");
    try {
      const victim = await cluster.start("publisher", { SQS_ENDPOINT: proxy.origin });
      await eventually(() => proxy.heldCount("SendMessage") === 1, "the publish to be held");
      const claimed = await world.sql(
        "select count(*)::int as n from outbox_messages where published_at is null and attempts = 1",
      );
      expect(claimed[0]?.n).toBeGreaterThanOrEqual(ids.length);
      await victim.kill("SIGKILL");
    } finally {
      proxy.stop();
    }

    // Leased, so invisible to everyone until the lease (2 s) ends; then the survivors take them.
    await Promise.all([cluster.start("publisher"), cluster.start("publisher")]);
    await eventually(allPublished, "the survivors to publish what the dead one had claimed", 60_000);

    const received = await eventsOf(wallets);
    expect(new Set(received)).toEqual(new Set(ids));
    const n = await count(
      "select count(*)::int as n from outbox_messages where aggregate_id = any(?::uuid[]) and attempts = 1",
      [`{${wallets.map((wallet) => wallet.walletId).join(",")}}`],
    );
    // The dead one's claim counted, so what it held was claimed twice in all.
    expect(n).toBe(0);
    await expectBooksBalance(wallets);
  });
});

describe("7. a reversal delivered before its reference", () => {
  test("settles once its bet arrives, with two workers looking and neither settling it twice", async () => {
    const [front, back] = await Promise.all([cluster.start("api"), cluster.start("api,reference-worker")]);
    await cluster.start("reference-worker");

    const refundOnly = await world.openWallet("100.00");
    const bet = command(refundOnly, { money: brl("80.00") });
    const refund = command(refundOnly, {
      kind: Kind.Refund,
      money: brl("80.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const early = await submit(front, refund);
    expect(early.status).toBe(202);
    expect((await early.json()).status).toBe("PENDING_REFERENCE");
    // Looked at while the bet is still missing: it keeps waiting.
    await eventually(
      async () =>
        (
          await world.sql("select retry_attempts as n from wager_transactions where idempotency_key = ?", [
            refund.idempotencyKey,
          ])
        )[0]?.n >= 1,
      "a worker to look at it before the bet exists",
    );
    expect((await submit(back, bet)).status).toBe(200);

    // The chain: a rollback of a refund of a bet, all arriving before the bet.
    const chain = await world.openWallet("100.00");
    const chainBet = command(chain, { money: brl("80.00") });
    const chainRefund = command(chain, {
      kind: Kind.Refund,
      money: brl("80.00"),
      referenceExternalTransactionId: chainBet.externalTransactionId,
    });
    const chainRollback = command(chain, {
      kind: Kind.Rollback,
      money: brl("80.00"),
      referenceExternalTransactionId: chainRefund.externalTransactionId,
    });
    expect((await submit(front, chainRollback)).status).toBe(202);
    expect((await submit(back, chainRefund)).status).toBe(202);
    expect((await submit(front, chainBet)).status).toBe(200);

    await eventually(
      async () => {
        const rows = await world.sql(
          "select count(*)::int as n from wager_transactions where wallet_id = any(?::uuid[]) and status = 'PENDING_REFERENCE'",
          [`{${refundOnly.walletId},${chain.walletId}}`],
        );
        return rows[0]?.n === 0;
      },
      "the waiting reversals to settle",
      60_000,
    );

    // Refund of the bet: back to 100.00. Bet, refund, then the refund rolled back: 20.00.
    expect(await world.walletState(refundOnly.walletId)).toEqual({ balance: "100.00", version: 3 });
    expect(await world.walletState(chain.walletId)).toEqual({ balance: "20.00", version: 4 });
    for (const wallet of [refundOnly, chain]) {
      const processed = await world.sql(
        "select count(*)::int as n from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionProcessed'",
        [wallet.walletId],
      );
      // One event per processed transaction: none settled twice.
      expect(processed[0]?.n).toBe(wallet === refundOnly ? 2 : 3);
    }
    await expectBooksBalance([refundOnly, chain]);
  });
});

describe("7b. many reversals due at the same moment, three workers", () => {
  test("each is claimed once and settled once", async () => {
    // A first look 30 s away, so nothing happens until the test makes them all due at once.
    const slow = { REFERENCE_RETRY_BASE_SECONDS: "30", REFERENCE_RETRY_CAP_SECONDS: "30" };
    const front = await cluster.start("api", slow);
    const workers = await Promise.all(
      Array.from({ length: 3 }, () => cluster.start("reference-worker", slow)),
    );

    const wallets = await Promise.all(Array.from({ length: 40 }, () => world.openWallet("100.00")));
    const refunds: Operation[] = [];
    for (const wallet of wallets) {
      const bet = command(wallet, { money: brl("80.00") });
      const refund = command(wallet, {
        kind: Kind.Refund,
        money: brl("80.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      refunds.push(refund);
      expect((await submit(front, refund)).status).toBe(202);
      expect((await submit(front, bet)).status).toBe(200);
    }

    await world.sql(
      "update wager_transactions set next_retry_at = now() - interval '1 second' where status = 'PENDING_REFERENCE'",
    );
    await eventually(
      async () =>
        (await count(
          "select count(*)::int as n from wager_transactions where wallet_id = any(?::uuid[]) and status = 'PENDING_REFERENCE'",
          [`{${wallets.map((wallet) => wallet.walletId).join(",")}}`],
        )) === 0,
      "all the reversals to settle",
      60_000,
    );

    // Claimed once each: a row two workers both took would have been counted twice.
    expect(
      await count(
        "select count(*)::int as n from wager_transactions where idempotency_key = any(?::text[]) and retry_attempts <> 1",
        [`{${refunds.map((refund) => refund.idempotencyKey).join(",")}}`],
      ),
    ).toBe(0);
    for (const wallet of wallets) {
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 3 });
    }
    // And none settled twice: a second try at a settled transaction would have been logged as a failure.
    expect(workers.map((worker) => worker.output()).join("\n")).not.toContain("could not be settled");
    await expectBooksBalance(wallets);
  });
});

describe("8. every process killed, then restarted", () => {
  test("work lost mid-flight is redone exactly once, and the books balance", async () => {
    const roles = "api,consumer,publisher,reference-worker";
    const first = await Promise.all(Array.from({ length: 3 }, () => cluster.start(roles)));
    const wallets = await Promise.all(Array.from({ length: 30 }, () => world.openWallet("100.00")));
    const stuck = wallets.slice(0, 8);
    const free = wallets.slice(8);
    const requests = wallets.flatMap((wallet) =>
      Array.from({ length: 3 }, () => command(wallet, { money: brl("10.00") })),
    );

    // The stuck wallets' locks are held, so their requests are in a transaction, waiting, when the processes die.
    const releases = await Promise.all(stuck.map((wallet) => world.holdLock(wallet.walletId)));
    let released = false;
    const releaseAll = async () => {
      if (released) return;
      released = true;
      await Promise.all(releases.map((release) => release()));
    };
    try {
      const inFlight = requests.map((op, i) => submit(roundRobin(first, i), op).catch(() => undefined));
      void inFlight;

      let seen = "nothing yet";
      await eventually(
        async () => {
          const done = await count(
            "select count(*)::int as n from wager_transactions where wallet_id = any(?::uuid[]) and kind <> 'OPENING'",
            [`{${free.map((wallet) => wallet.walletId).join(",")}}`],
          );
          const waiting = await count(
            "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
          );
          seen = `${done} of ${free.length * 3} free transactions committed, ${waiting} of ${stuck.length} backends waiting on a lock`;
          return done === free.length * 3 && waiting >= stuck.length;
        },
        () => `the free wallets to finish and the stuck ones to be waiting on their locks; saw ${seen}`,
        60_000,
      );

      await Promise.all(first.map((proc) => proc.kill("SIGKILL")));
      await releaseAll();

      // The kill really lost work: nothing of the stuck wallets was committed, and everything else was.
      for (const wallet of stuck) expect((await world.counts(wallet.walletId)).transactions).toBe(0);
      for (const wallet of free) expect((await world.counts(wallet.walletId)).transactions).toBe(3);

      // New processes; every request is sent again with the same key.
      const second = await Promise.all(Array.from({ length: 3 }, () => cluster.start(roles)));
      const replies = await Promise.all(requests.map((op, i) => submit(roundRobin(second, i), op)));
      const answers = await Promise.all(
        replies.map(async (reply) => `${reply.status} ${JSON.stringify(await reply.json())}`),
      );
      expect({
        refused: answers.filter((answer) => !answer.startsWith("200 ")),
        logged: errorsOf(second),
      }).toEqual({
        refused: [],
        logged: [],
      });

      for (const wallet of wallets) {
        expect(await world.walletState(wallet.walletId)).toEqual({ balance: "70.00", version: 4 });
        expect((await world.counts(wallet.walletId)).transactions).toBe(3);
      }
      await expectBooksBalance(wallets);

      // Reconciliation, as an operator would run it, agrees on every wallet.
      for (const [index, wallet] of wallets.entries()) {
        const report = await (
          await call(`${roundRobin(second, index).url}/wallets/${wallet.walletId}/reconciliation`, {
            method: "POST",
          })
        ).json();
        expect(report.consistent).toBe(true);
      }

      // Events the dead processes committed and never published are published by the new ones.
      await eventually(allPublished, "the restarted publishers to catch up", 60_000);
      const ids = (
        await world.sql("select id from outbox_messages where aggregate_id = any(?::uuid[])", [
          `{${wallets.map((wallet) => wallet.walletId).join(",")}}`,
        ])
      ).map((row) => row.id as string);
      expect(new Set(await eventsOf(wallets))).toEqual(new Set(ids));
    } finally {
      // Held locks would hold the pool open, and the database with it, if the test failed before here.
      await releaseAll();
    }
  });
});
