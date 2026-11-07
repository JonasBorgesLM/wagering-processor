import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MessageIdConflictError, WalletNotFoundError } from "../../src/wagering/application/errors";
import { payloadHash } from "../../src/wagering/application/payload-hash";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/wagering/domain/wager-transaction";
import { brl, command, instrumented, SettlementWorld } from "../support/settlement";

// Requirements: FR-77, NFR-04, NFR-05, INT-17.
// The inbox is written in the transaction that settles the message, so these run the real use case on a real
// database (NFR-04, NFR-05, §10).

let world: SettlementWorld;
beforeAll(async () => {
  world = await SettlementWorld.create();
});
afterAll(() => world.destroy());

const CONSUMER = "wager-transactions";
const source = (messageId: string, consumerName = CONSUMER) => ({ consumerName, messageId });
const inboxRows = (messageId: string) =>
  world.sql("select consumer_name, payload_hash, processed_at from inbox_messages where message_id = ?", [
    messageId,
  ]);

describe("a first delivery", () => {
  test("is recorded with its effect, under the hash of the operation", async () => {
    const wallet = await world.openWallet("100.00");
    const operation = command(wallet);
    const result = await world.useCase.execute(operation, source("msg-first"));

    expect(result).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    const rows = await inboxRows("msg-first");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ consumer_name: CONSUMER, payload_hash: payloadHash(operation) });
    expect(rows[0]?.processed_at).not.toBeNull();
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
  });

  test("a business rejection is recorded too: it is an answer, and committing it is how it stays answered", async () => {
    const wallet = await world.openWallet("10.00");
    const result = await world.useCase.execute(command(wallet), source("msg-rejected"));
    expect(result.status).toBe(Status.Rejected);
    expect(await inboxRows("msg-rejected")).toHaveLength(1);
    expect(await world.counts(wallet.walletId)).toMatchObject({ transactions: 1, entries: 0, events: 1 });
  });

  test("the inbox is written before the wallet is locked, and nothing writes before it", async () => {
    const wallet = await world.openWallet("100.00");
    const calls: string[] = [];
    const spy = instrumented(world.unitOfWork, (call, phase) => {
      if (phase === "before") calls.push(call);
    });
    await world.useCaseWith(spy).execute(command(wallet), source("msg-order"));
    expect(calls.slice(0, 3)).toEqual([
      "transactions.findByKey",
      "transactions.findByExternalId",
      "inbox.record",
    ]);
    expect(calls.indexOf("inbox.record")).toBeLessThan(calls.indexOf("wallets.lockById"));
    expect(calls.indexOf("wallets.lockById")).toBeLessThan(calls.indexOf("transactions.insert"));
  });
});

describe("a redelivery changes nothing", () => {
  test("the same message again is a replay of the same transaction", async () => {
    const wallet = await world.openWallet("100.00");
    const operation = command(wallet);
    const first = await world.useCase.execute(operation, source("msg-again"));
    const second = await world.useCase.execute(operation, source("msg-again"));

    expect(second).toMatchObject({ transactionId: first.transactionId, idempotentReplay: true });
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
    expect(await inboxRows("msg-again")).toHaveLength(1);
  });

  test("a new message id with a known key is a replay, and is not recorded (section 3.11)", async () => {
    const wallet = await world.openWallet("100.00");
    const operation = command(wallet);
    await world.useCase.execute(operation, source("msg-original"));
    const again = await world.useCase.execute(operation, source("msg-resent"));

    expect(again.idempotentReplay).toBe(true);
    expect(await inboxRows("msg-resent")).toHaveLength(0);
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
  });

  test("the same operation over HTTP and then over the queue is one operation", async () => {
    const wallet = await world.openWallet("100.00");
    const operation = command(wallet);
    await world.useCase.execute(operation);
    const viaQueue = await world.useCase.execute(operation, source("msg-after-http"));
    expect(viaQueue.idempotentReplay).toBe(true);
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
  });

  test("twenty deliveries of one message at once apply it once", async () => {
    const wallet = await world.openWallet("100.00");
    const operation = command(wallet);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => world.useCase.execute(operation, source("msg-storm"))),
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "20.00", version: 2 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
    expect(await inboxRows("msg-storm")).toHaveLength(1);
  });

  test("the same message id under another consumer is another message", async () => {
    const wallet = await world.openWallet("100.00");
    await world.useCase.execute(command(wallet, { money: brl("1.00") }), source("msg-shared", "consumer-a"));
    await world.useCase.execute(command(wallet, { money: brl("2.00") }), source("msg-shared", "consumer-b"));
    expect(await inboxRows("msg-shared")).toHaveLength(2);
  });
});

describe("one message id with different content (INT-17)", () => {
  test("is refused, and neither the inbox nor the wallet moves", async () => {
    const wallet = await world.openWallet("100.00");
    const original = command(wallet, { money: brl("10.00") });
    await world.useCase.execute(original, source("msg-lie"));
    const before = await inboxRows("msg-lie");

    const other = command(wallet, { money: brl("30.00") });
    await expect(world.useCase.execute(other, source("msg-lie"))).rejects.toThrow(MessageIdConflictError);

    expect(await inboxRows("msg-lie")).toEqual(before);
    expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "90.00", version: 2 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });
});

describe("the inbox rolls back with the financial change (NFR-04)", () => {
  class Crash extends Error {}
  const writes = ["inbox.record", "transactions.insert", "wallets.save", "ledger.append", "outbox.enqueue"];

  test.each(writes)(
    "a crash right after %s leaves no inbox row, and the redelivery applies once",
    async (write) => {
      const wallet = await world.openWallet("100.00");
      const operation = command(wallet);
      const id = `msg-crash-${write}`;
      const failing = instrumented(world.unitOfWork, (call, phase) => {
        if (call === write && phase === "after") throw new Crash();
      });

      await expect(world.useCaseWith(failing).execute(operation, source(id))).rejects.toThrow(Crash);
      expect(await inboxRows(id)).toHaveLength(0);
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 0, entries: 0, events: 0 });
      expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 1 });

      // If the inbox row had survived, this would be taken for a duplicate and acknowledged with nothing done.
      const redelivery = await world.useCase.execute(operation, source(id));
      expect(redelivery.idempotentReplay).toBe(false);
      expect(await inboxRows(id)).toHaveLength(1);
      expect(await world.counts(wallet.walletId)).toEqual({ transactions: 1, entries: 1, events: 2 });
      await world.expectLedgerExplainsBalance(wallet.walletId);
    },
  );

  test("a message for a wallet that does not exist is not recorded either", async () => {
    const missing = { walletId: crypto.randomUUID(), playerId: crypto.randomUUID() };
    await expect(world.useCase.execute(command(missing), source("msg-nowhere"))).rejects.toThrow(
      WalletNotFoundError,
    );
    expect(await inboxRows("msg-nowhere")).toHaveLength(0);
  });

  test("the same holds for every kind of operation, so a reversal is not special", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet, { money: brl("40.00") });
    await world.useCase.execute(bet, source("msg-bet"));
    const refund = command(wallet, {
      kind: Kind.Refund,
      money: brl("40.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const failing = instrumented(world.unitOfWork, (call, phase) => {
      if (call === "ledger.append" && phase === "after") throw new Crash();
    });
    await expect(world.useCaseWith(failing).execute(refund, source("msg-refund"))).rejects.toThrow(Crash);
    expect(await inboxRows("msg-refund")).toHaveLength(0);
    expect((await world.useCase.execute(refund, source("msg-refund"))).status).toBe(Status.Processed);
    expect(await world.walletState(wallet.walletId)).toEqual({ balance: "100.00", version: 3 });
    await world.expectLedgerExplainsBalance(wallet.walletId);
  });
});
