import { describe, expect, test } from "bun:test";
import { InvalidIntegrationEventError } from "../../../src/wagering/domain/errors";
import {
  type EventContext,
  IntegrationEvent,
  type IntegrationEventProps,
} from "../../../src/wagering/domain/integration-event";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from "../../../src/wagering/domain/wager-transaction";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../../src/wagering/domain/wagering-events";
import { Wallet } from "../../../src/wagering/domain/wallet";
import { brl, stored, T0, transaction, walletWith } from "../../support/domain-fixtures";

// Requirements: FR-92 (an event is built only from the state it describes), FR-93 (the wallet is the aggregate), FR-94 (the version-1 format is pinned by its expected JSON).

const OCCURRED = new Date("2026-11-05T12:00:00.000Z");
const PROCESSED_AT = new Date("2026-11-05T13:00:00.000Z");

const context = (overrides: Partial<EventContext> = {}): EventContext => ({
  eventId: "ev-1",
  correlationId: "corr-1",
  causationId: "msg-1",
  occurredAt: OCCURRED,
  ...overrides,
});

const base = { id: "tx-1", externalTransactionId: "ext-1", money: brl("25.00") };

function processedBet(): WagerTransaction {
  const t = transaction(Kind.Bet, base);
  t.markProcessed(undefined, brl("975.00"), PROCESSED_AT);
  return t;
}

function rejectedBet(): WagerTransaction {
  const t = transaction(Kind.Bet, base);
  t.reject("INSUFFICIENT_FUNDS", brl("10.00"));
  return t;
}

/** Built apart from rejectedBet on purpose: a default parameter would swallow an explicit `undefined` balance. */
function rejectedWithoutBalance(code: "PLAYER_WALLET_MISMATCH" | "CURRENCY_MISMATCH"): WagerTransaction {
  const t = transaction(Kind.Bet, base);
  t.reject(code, undefined);
  return t;
}

function waitingRefund(): WagerTransaction {
  const t = transaction(Kind.Refund, { ...base, referenceExternalTransactionId: "ext-0" });
  t.markPendingReference(brl("975.00"));
  return t;
}

/** The wire form a consumer sees, as the outbox will store it. */
const wire = (event: { toJSON(): unknown }) => JSON.parse(JSON.stringify(event));

const FACTS = {
  transactionId: "tx-1",
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  walletId: "w1",
  playerId: "p1",
  roundId: "round-1",
  gameId: "game-1",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("the wire format is a contract (version 1)", () => {
  test("WagerTransactionProcessed", () => {
    expect(wire(WagerTransactionProcessed.from(processedBet(), context()))).toStrictEqual({
      eventId: "ev-1",
      eventType: "WagerTransactionProcessed",
      aggregateId: "w1",
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-11-05T12:00:00.000Z",
      version: 1,
      data: {
        ...FACTS,
        balance: { amount: "975.00", currency: "BRL" },
        processedAt: "2026-11-05T13:00:00.000Z",
      },
    });
  });

  test("WagerTransactionRejected", () => {
    expect(wire(WagerTransactionRejected.from(rejectedBet(), context()))).toStrictEqual({
      eventId: "ev-1",
      eventType: "WagerTransactionRejected",
      aggregateId: "w1",
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-11-05T12:00:00.000Z",
      version: 1,
      data: { ...FACTS, failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "10.00", currency: "BRL" } },
    });
  });

  test("WagerTransactionPendingReference", () => {
    expect(wire(WagerTransactionPendingReference.from(waitingRefund(), context()))).toStrictEqual({
      eventId: "ev-1",
      eventType: "WagerTransactionPendingReference",
      aggregateId: "w1",
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-11-05T12:00:00.000Z",
      version: 1,
      data: {
        ...FACTS,
        kind: "REFUND",
        referenceExternalTransactionId: "ext-0",
        balance: { amount: "975.00", currency: "BRL" },
      },
    });
  });

  test("WalletBalanceChanged", () => {
    const wallet = walletWith("1000.00");
    const entry = wallet.debit(brl("25.00"), { transactionId: "tx-1", entryId: "e-1", at: PROCESSED_AT });
    expect(wire(WalletBalanceChanged.from(wallet, entry, context()))).toStrictEqual({
      eventId: "ev-1",
      eventType: "WalletBalanceChanged",
      aggregateId: "w1",
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-11-05T12:00:00.000Z",
      version: 1,
      data: {
        walletId: "w1",
        transactionId: "tx-1",
        direction: "DEBIT",
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "1000.00", currency: "BRL" },
        balanceAfter: { amount: "975.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
  });

  test("a processed reversal links the transaction it reversed", () => {
    const refund = transaction(Kind.Refund, { ...base, referenceExternalTransactionId: "ext-0" });
    refund.markProcessed("tx-0", brl("1000.00"), PROCESSED_AT);
    expect(WagerTransactionProcessed.from(refund, context()).data.referenceTransactionId).toBe("tx-0");
  });

  test("an unlinked transaction has no such key at all, rather than a null", () => {
    expect(
      "referenceTransactionId" in wire(WagerTransactionProcessed.from(processedBet(), context())).data,
    ).toBe(false);
  });

  test("the event names are exactly the ones section 11 lists", () => {
    const wallet = walletWith("100.00");
    const entry = wallet.credit(brl("1.00"), { transactionId: "t", entryId: "e", at: T0 });
    const names = [
      WagerTransactionProcessed.from(processedBet(), context()),
      WagerTransactionRejected.from(rejectedBet(), context()),
      WagerTransactionPendingReference.from(waitingRefund(), context()),
      WalletBalanceChanged.from(wallet, entry, context()),
    ].map((event) => event.eventType);
    expect(names).toEqual([
      "WagerTransactionProcessed",
      "WagerTransactionRejected",
      "WagerTransactionPendingReference",
      "WalletBalanceChanged",
    ]);
  });
});

describe("a LOSS is still processed (§11)", () => {
  test("it publishes WagerTransactionProcessed, with the balance it saw", () => {
    const loss = transaction(Kind.Loss, { ...base, money: brl("0.00") });
    loss.markProcessed(undefined, brl("975.00"), PROCESSED_AT);
    const event = WagerTransactionProcessed.from(loss, context());
    expect(event.data.kind).toBe(Kind.Loss);
    expect(event.data.balance.amount).toBe("975.00");
  });
});

describe("a rejection discloses a balance only when the response does (FR-58)", () => {
  test.each(["PLAYER_WALLET_MISMATCH", "CURRENCY_MISMATCH"] as const)("%s carries none", (code) => {
    const event = WagerTransactionRejected.from(rejectedWithoutBalance(code), context());
    expect("balance" in wire(event).data).toBe(false);
    expect(event.data.failureCode).toBe(code);
  });
});

describe("the aggregate is always the wallet", () => {
  // The outbox uses it as the FIFO message group, which keeps one wallet's events in order (ADR-0007).
  test("whatever the event", () => {
    const wallet = walletWith("100.00");
    const entry = wallet.credit(brl("1.00"), { transactionId: "t", entryId: "e", at: T0 });
    for (const event of [
      WagerTransactionProcessed.from(processedBet(), context()),
      WagerTransactionRejected.from(rejectedBet(), context()),
      WagerTransactionPendingReference.from(waitingRefund(), context()),
      WalletBalanceChanged.from(wallet, entry, context()),
    ]) {
      expect(event.aggregateId).toBe("w1");
    }
  });
});

describe("opening a wallet publishes a balance change (INT-18)", () => {
  test("at version 1, from zero", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: brl("1000.00"),
      at: T0,
      opening: { transactionId: "open-t", entryId: "open-e" },
    });
    expect(openingEntry).toBeDefined();
    if (!openingEntry) return;
    const event = WalletBalanceChanged.from(wallet, openingEntry, context());
    expect(event.data).toMatchObject({
      direction: "CREDIT",
      walletVersion: 1,
      balanceBefore: { amount: "0.00" },
      balanceAfter: { amount: "1000.00" },
    });
  });
});

describe("a payload is plain JSON, never a domain object (§11)", () => {
  function plain(value: unknown, path = "data"): void {
    expect(typeof value, `${path} must not be a bigint`).not.toBe("bigint");
    expect(typeof value, `${path} must not be a function`).not.toBe("function");
    if (typeof value === "object" && value !== null) {
      expect(Object.getPrototypeOf(value), `${path} must be a plain object`).toBe(Object.prototype);
      for (const [key, member] of Object.entries(value)) plain(member, `${path}.${key}`);
    }
  }

  test("no Money, no bigint, no class instance anywhere in any event", () => {
    const wallet = walletWith("100.00");
    const entry = wallet.credit(brl("1.00"), { transactionId: "t", entryId: "e", at: T0 });
    for (const event of [
      WagerTransactionProcessed.from(processedBet(), context()),
      WagerTransactionRejected.from(rejectedBet(), context()),
      WagerTransactionPendingReference.from(waitingRefund(), context()),
      WalletBalanceChanged.from(wallet, entry, context()),
    ]) {
      plain(event.data);
      // A bigint would make this throw, so serializing proves the point from the other side.
      expect(() => JSON.stringify(event)).not.toThrow();
    }
  });

  test("the envelope survives a round trip unchanged", () => {
    const event = WagerTransactionProcessed.from(processedBet(), context());
    expect(wire(event)).toStrictEqual(JSON.parse(JSON.stringify(wire(event))));
    expect(wire(event)).toStrictEqual(JSON.parse(JSON.stringify(event.toJSON())));
  });
});

describe("the envelope", () => {
  test("omits causationId when there is none, rather than writing null", () => {
    const event = WagerTransactionProcessed.from(processedBet(), context({ causationId: undefined }));
    // Checked on the envelope object itself: JSON.stringify would drop an undefined value and hide the key.
    expect("causationId" in event.toJSON()).toBe(false);
    expect("causationId" in wire(event)).toBe(false);
    expect(event.causationId).toBeUndefined();
  });

  test.each([
    ["eventId", { eventId: " " }],
    ["correlationId", { correlationId: "" }],
    ["causationId", { causationId: " " }],
    ["occurredAt", { occurredAt: new Date("nope") }],
  ])("refuses an unusable %s", (_name, overrides) => {
    expect(() => WagerTransactionProcessed.from(processedBet(), context(overrides))).toThrow(
      InvalidIntegrationEventError,
    );
  });

  test("copies its date in and out", () => {
    const at = new Date(OCCURRED);
    const event = WagerTransactionProcessed.from(processedBet(), context({ occurredAt: at }));
    at.setFullYear(1999);
    event.occurredAt.setFullYear(1999);
    expect(wire(event).occurredAt).toBe("2026-11-05T12:00:00.000Z");
  });

  // The payload is a contract, so it must not change after the event exists.
  test("data cannot be altered, at any depth", () => {
    const event = WagerTransactionProcessed.from(processedBet(), context());
    expect(() => {
      (event.data as { kind: string }).kind = "WIN";
    }).toThrow(TypeError);
    expect(() => {
      (event.data.money as { amount: string }).amount = "1.00";
    }).toThrow(TypeError);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.balance)).toBe(true);
    expect(event.data.money.amount).toBe("25.00");
  });
});

describe("an event describes the state it was built from", () => {
  const events: Array<[string, (t: WagerTransaction) => unknown, Status]> = [
    ["WagerTransactionProcessed", (t) => WagerTransactionProcessed.from(t, context()), Status.Processed],
    ["WagerTransactionRejected", (t) => WagerTransactionRejected.from(t, context()), Status.Rejected],
    [
      "WagerTransactionPendingReference",
      (t) => WagerTransactionPendingReference.from(t, context()),
      Status.PendingReference,
    ],
  ];

  for (const [name, build, wanted] of events) {
    test.each(Object.values(Status).filter((status) => status !== wanted))(
      `${name} refuses a transaction that is %s`,
      (status) => {
        expect(() => build(stored(Kind.Refund, status))).toThrow(InvalidIntegrationEventError);
      },
    );
  }

  // Each of these rows is complete apart from its status, so the status check is the only thing that can refuse
  // it. The loop above is not enough: a bare stored row also lacks a balance, and that guard would answer first.
  describe("the status alone is enough to refuse", () => {
    const outcome = {
      observedBalance: brl("10.00"),
      processedAt: PROCESSED_AT,
      failureCode: "INSUFFICIENT_FUNDS" as const,
    };

    test("a transaction that was not processed", () => {
      for (const status of [Status.Rejected, Status.PendingReference, Status.Pending]) {
        expect(() =>
          WagerTransactionProcessed.from(
            stored(
              Kind.Bet,
              status,
              {},
              { observedBalance: outcome.observedBalance, processedAt: outcome.processedAt },
            ),
            context(),
          ),
        ).toThrow(/describes a PROCESSED transaction/);
      }
    });

    test("a transaction that was not rejected", () => {
      for (const status of [Status.Processed, Status.PendingReference, Status.Pending]) {
        expect(() =>
          WagerTransactionRejected.from(
            stored(Kind.Bet, status, {}, { failureCode: outcome.failureCode }),
            context(),
          ),
        ).toThrow(/describes a REJECTED transaction/);
      }
    });

    test("a transaction that is not waiting", () => {
      for (const status of [Status.Processed, Status.Rejected, Status.Pending]) {
        expect(() =>
          WagerTransactionPendingReference.from(
            stored(
              Kind.Refund,
              status,
              { referenceExternalTransactionId: "ref-ext", externalTransactionId: "own-ext" },
              { observedBalance: outcome.observedBalance },
            ),
            context(),
          ),
        ).toThrow(/describes a PENDING_REFERENCE transaction/);
      }
    });
  });

  test("a rejection must carry a rejection code, not an infrastructure one", () => {
    const row = stored(Kind.Bet, Status.Rejected, {}, { failureCode: "SETTLEMENT_FAILED" });
    expect(() => WagerTransactionRejected.from(row, context())).toThrow(/rejection code/);
  });

  test("a stored 'processed' row with no balance cannot be described", () => {
    expect(() => WagerTransactionProcessed.from(stored(Kind.Bet, Status.Processed), context())).toThrow(
      InvalidIntegrationEventError,
    );
  });

  test("a stored 'rejected' row with no code cannot be described", () => {
    expect(() => WagerTransactionRejected.from(stored(Kind.Bet, Status.Rejected), context())).toThrow(
      InvalidIntegrationEventError,
    );
  });

  test("an infrastructure failure is not a rejection, so it has no such event", () => {
    const failed = transaction(Kind.Bet, base);
    failed.fail("SETTLEMENT_FAILED");
    expect(() => WagerTransactionRejected.from(failed, context())).toThrow(InvalidIntegrationEventError);
  });

  test("a balance change refuses an entry from another wallet", () => {
    const wallet = walletWith("100.00");
    const other = walletWith("100.00", { id: "w2" });
    // Same version and same balance as `wallet` after its own credit, so only the wallet id tells them apart.
    wallet.credit(brl("1.00"), { transactionId: "t0", entryId: "e0", at: T0 });
    const entry = other.credit(brl("1.00"), { transactionId: "t", entryId: "e", at: T0 });
    expect(entry.walletVersion).toBe(wallet.version);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(() => WalletBalanceChanged.from(wallet, entry, context())).toThrow(/another wallet/);
  });

  test("a balance change refuses an entry whose balance is not the wallet's, even at the same version", () => {
    const wallet = walletWith("100.00");
    const lookalike = walletWith("100.00");
    wallet.credit(brl("1.00"), { transactionId: "t1", entryId: "e1", at: T0 });
    const entry = lookalike.credit(brl("2.00"), { transactionId: "t2", entryId: "e2", at: T0 });
    expect(entry.walletVersion).toBe(wallet.version);
    expect(() => WalletBalanceChanged.from(wallet, entry, context())).toThrow(InvalidIntegrationEventError);
  });

  test("a balance change refuses an entry from an earlier version, even when the balance happens to match", () => {
    const wallet = walletWith("100.00");
    const first = wallet.credit(brl("1.00"), { transactionId: "t1", entryId: "e1", at: T0 });
    wallet.credit(brl("1.00"), { transactionId: "t2", entryId: "e2", at: T0 });
    wallet.debit(brl("1.00"), { transactionId: "t3", entryId: "e3", at: T0 });
    // The wallet is back to the balance the first entry left, but two versions later.
    expect(first.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(first.walletVersion).not.toBe(wallet.version);
    expect(() => WalletBalanceChanged.from(wallet, first, context())).toThrow(/latest change/);
  });

  test("a balance change refuses a stale entry, since it would publish a balance the wallet no longer has", () => {
    const wallet = walletWith("100.00");
    const first = wallet.credit(brl("1.00"), { transactionId: "t1", entryId: "e1", at: T0 });
    wallet.credit(brl("1.00"), { transactionId: "t2", entryId: "e2", at: T0 });
    expect(() => WalletBalanceChanged.from(wallet, first, context())).toThrow(InvalidIntegrationEventError);
  });
});

// The base class is checked on its own, through a minimal subclass, so its rules do not depend on how a
// particular event happens to build its inputs.
describe("IntegrationEvent (the base class)", () => {
  class Probe extends IntegrationEvent<{ nested: { value: string }; list: string[] }> {
    readonly eventType = "Probe";
    readonly version = 7;
    static make(
      overrides: Partial<IntegrationEventProps<{ nested: { value: string }; list: string[] }>> = {},
    ) {
      return new Probe({
        eventId: "ev-1",
        aggregateId: "agg-1",
        correlationId: "corr-1",
        occurredAt: OCCURRED,
        data: { nested: { value: "a" }, list: ["x"] },
        ...overrides,
      });
    }
  }

  test("takes its type name and version from the class, not from the caller", () => {
    expect(Probe.make().toJSON()).toMatchObject({ eventType: "Probe", version: 7 });
  });

  test.each([
    ["eventId", { eventId: "" }],
    ["aggregateId", { aggregateId: " " }],
    ["correlationId", { correlationId: "" }],
    ["causationId", { causationId: "" }],
    ["occurredAt", { occurredAt: new Date("nope") }],
  ])("refuses an unusable %s", (_name, overrides) => {
    expect(() => Probe.make(overrides)).toThrow(InvalidIntegrationEventError);
  });

  test("freezes the payload at every depth, arrays included", () => {
    const event = Probe.make();
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.nested)).toBe(true);
    expect(Object.isFrozen(event.data.list)).toBe(true);
    expect(() => {
      (event.data.nested as { value: string }).value = "b";
    }).toThrow(TypeError);
    expect(() => (event.data.list as string[]).push("y")).toThrow(TypeError);
  });

  test("the envelope has exactly the documented keys", () => {
    expect(Object.keys(Probe.make({ causationId: "msg-1" }).toJSON()).sort()).toEqual(
      [
        "aggregateId",
        "causationId",
        "correlationId",
        "data",
        "eventId",
        "eventType",
        "occurredAt",
        "version",
      ].sort(),
    );
    expect(Object.keys(Probe.make().toJSON())).not.toContain("causationId");
  });

  test("the date is copied in and copied out", () => {
    const at = new Date(OCCURRED);
    const event = Probe.make({ occurredAt: at });
    at.setFullYear(1999);
    event.occurredAt.setFullYear(1999);
    expect(event.toJSON().occurredAt).toBe("2026-11-05T12:00:00.000Z");
  });
});
