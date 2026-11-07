import { describe, expect, test } from "bun:test";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "../../../src/wagering/domain/errors";
import { REJECTION_CODES } from "../../../src/wagering/domain/failure-code";
import { Money } from "../../../src/wagering/domain/money";
import {
  type CreateWagerTransactionProps,
  INTERNAL_PROVIDER_ID,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  WagerTransaction,
  type WagerTransactionState,
} from "../../../src/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../../src/wagering/domain/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const AT = new Date("2026-11-05T12:00:00.000Z");
const LATER = new Date("2026-11-05T13:00:00.000Z");

const props = (
  kind: Kind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: "t1",
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  idempotencyKey: "provider-a:ext-1",
  payloadHash: "hash-1",
  walletId: "w1",
  playerId: "p1",
  roundId: "round-1",
  gameId: "game-1",
  kind,
  money: brl("25.00"),
  createdAt: AT,
  ...(kind === Kind.Refund || kind === Kind.Rollback ? { referenceExternalTransactionId: "ext-0" } : {}),
  ...overrides,
});

const make = (kind: Kind, overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(props(kind, overrides));

/** A stored row in any status, for testing transitions from states create() never produces. */
function stored(status: Status, kind: Kind = Kind.Refund): WagerTransaction {
  const base =
    kind === Kind.Opening
      ? WagerTransaction.createOpening({
          id: "o1",
          walletId: "w1",
          playerId: "p1",
          money: brl("25.00"),
          createdAt: AT,
        })
      : make(kind);
  const state: WagerTransactionState = {
    id: base.id,
    providerId: base.providerId,
    externalTransactionId: base.externalTransactionId,
    idempotencyKey: base.idempotencyKey,
    payloadHash: base.payloadHash,
    walletId: base.walletId,
    playerId: base.playerId,
    roundId: base.roundId,
    gameId: base.gameId,
    kind: base.kind,
    money: base.money,
    referenceExternalTransactionId: base.referenceExternalTransactionId,
    createdAt: base.createdAt,
    status,
    referenceTransactionId: undefined,
    failureCode: undefined,
    observedBalance: undefined,
    processedAt: undefined,
  };
  return WagerTransaction.rehydrate(state);
}

const snapshot = (t: WagerTransaction) => ({
  status: t.status,
  referenceTransactionId: t.referenceTransactionId,
  failureCode: t.failureCode,
  observedBalance: t.observedBalance?.toString(),
  processedAt: t.processedAt?.toISOString(),
});

describe("create", () => {
  test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])(
    "%s is born PENDING with no outcome",
    (kind) => {
      const t = make(kind);
      expect(t.status).toBe(Status.Pending);
      expect(t.isTerminal()).toBe(false);
      expect(t.failureCode).toBeUndefined();
      expect(t.processedAt).toBeUndefined();
      expect(t.referenceTransactionId).toBeUndefined();
      expect(t.observedBalance).toBeUndefined();
    },
  );

  // §6.3 and FR-62: the submit path must have no way to make an OPENING.
  test("cannot create an OPENING, however the payload is shaped", () => {
    // The message is pinned so the explicit check is told apart from the generic unknown-kind one.
    expect(() => make(Kind.Opening)).toThrow("OPENING is internal");
    expect(() => make(Kind.Opening, { providerId: INTERNAL_PROVIDER_ID })).toThrow("OPENING is internal");
  });

  test("refuses the reserved provider id for every submittable kind", () => {
    for (const kind of [Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback]) {
      expect(() => make(kind, { providerId: INTERNAL_PROVIDER_ID })).toThrow(InvalidWagerTransactionError);
    }
  });

  test("refuses an unknown kind", () => {
    expect(() => make("SIDEWAYS" as Kind)).toThrow(InvalidWagerTransactionError);
  });

  describe("references", () => {
    test.each([Kind.Refund, Kind.Rollback])("%s requires one", (kind) => {
      expect(() => make(kind, { referenceExternalTransactionId: undefined })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    test.each([Kind.Win, Kind.Loss])("%s may carry one or not", (kind) => {
      expect(make(kind).referenceExternalTransactionId).toBeUndefined();
      expect(make(kind, { referenceExternalTransactionId: "ext-0" }).referenceExternalTransactionId).toBe(
        "ext-0",
      );
    });

    // A BET stands alone, so a reference on it is a malformed payload, not something to ignore.
    test("a BET cannot carry one", () => {
      expect(() => make(Kind.Bet, { referenceExternalTransactionId: "ext-0" })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    test("an empty reference is not a reference", () => {
      expect(() => make(Kind.Refund, { referenceExternalTransactionId: "  " })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    test("a transaction cannot reference itself", () => {
      expect(() => make(Kind.Refund, { referenceExternalTransactionId: "ext-1" })).toThrow(
        InvalidWagerTransactionError,
      );
    });
  });

  describe("amounts", () => {
    // INT-05: only LOSS may be zero.
    test("LOSS accepts zero and a positive amount", () => {
      expect(make(Kind.Loss, { money: brl("0.00") }).money.isZero()).toBe(true);
      expect(make(Kind.Loss, { money: brl("5.00") }).money.isPositive()).toBe(true);
    });

    test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])("%s refuses zero", (kind) => {
      expect(() => make(kind, { money: brl("0.00") })).toThrow(InvalidWagerTransactionError);
    });

    test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])(
      "%s refuses a negative amount",
      (kind) => {
        expect(() => make(kind, { money: brl("5.00").negate() })).toThrow(InvalidWagerTransactionError);
      },
    );
  });

  test.each([
    "id",
    "providerId",
    "externalTransactionId",
    "idempotencyKey",
    "payloadHash",
    "walletId",
    "playerId",
    "roundId",
    "gameId",
  ] as const)("refuses an empty %s", (field) => {
    expect(() => make(Kind.Bet, { [field]: " " })).toThrow(InvalidWagerTransactionError);
  });

  test("refuses an invalid date, and copies dates in and out", () => {
    expect(() => make(Kind.Bet, { createdAt: new Date("nope") })).toThrow(InvalidWagerTransactionError);
    const at = new Date(AT);
    const t = make(Kind.Bet, { createdAt: at });
    at.setFullYear(1999);
    t.createdAt.setFullYear(1999);
    expect(t.createdAt.toISOString()).toBe(AT.toISOString());
  });
});

describe("createOpening", () => {
  const opening = (overrides = {}) =>
    WagerTransaction.createOpening({
      id: "o1",
      walletId: "w1",
      playerId: "p1",
      money: brl("1000.00"),
      createdAt: AT,
      ...overrides,
    });

  test("is internal, credits, and takes no reference", () => {
    const t = opening();
    expect(t.kind).toBe(Kind.Opening);
    expect(t.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(t.referenceExternalTransactionId).toBeUndefined();
    expect(t.status).toBe(Status.Pending);
    expect(t.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  // The schema's unique idempotency key then keeps a second opening for one wallet out, not just this code.
  test("derives its keys from the wallet, so one wallet cannot be opened twice", () => {
    const first = opening();
    const again = opening({ id: "o2" });
    const other = opening({ id: "o3", walletId: "w2" });
    expect(again.idempotencyKey).toBe(first.idempotencyKey);
    expect(again.externalTransactionId).toBe(first.externalTransactionId);
    expect(other.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  test("needs a positive amount: a zero opening creates no transaction at all (FR-12)", () => {
    expect(() => opening({ money: brl("0.00") })).toThrow(InvalidWagerTransactionError);
    expect(() => opening({ money: brl("5.00").negate() })).toThrow(InvalidWagerTransactionError);
  });

  test("can be processed like any other, with no reference", () => {
    const t = opening();
    t.markProcessed(undefined, brl("1000.00"), LATER);
    expect(t.status).toBe(Status.Processed);
  });
});

describe("queries", () => {
  test.each([
    [Kind.Opening, true],
    [Kind.Bet, true],
    [Kind.Win, true],
    [Kind.Loss, false],
    [Kind.Refund, true],
    [Kind.Rollback, true],
  ])("affectsBalance for %s is %p", (kind, expected) => {
    expect(stored(Status.Pending, kind).affectsBalance()).toBe(expected);
  });

  test.each([
    [Kind.Bet, false],
    [Kind.Win, false],
    [Kind.Loss, false],
    [Kind.Refund, true],
    [Kind.Rollback, true],
  ])("requiresReference for %s is %p", (kind, expected) => {
    expect(make(kind).requiresReference()).toBe(expected);
  });

  test("matchesPayload compares the hash exactly", () => {
    const t = make(Kind.Bet, { payloadHash: "abc" });
    expect(t.matchesPayload("abc")).toBe(true);
    expect(t.matchesPayload("abd")).toBe(false);
    expect(t.matchesPayload("ABC")).toBe(false);
    expect(t.matchesPayload("")).toBe(false);
  });

  test.each([Status.Pending, Status.PendingReference, Status.Processed, Status.Rejected, Status.Failed])(
    "isTerminal for %s",
    (status) => {
      const terminal = [Status.Processed, Status.Rejected, Status.Failed].includes(status);
      expect(stored(status).isTerminal()).toBe(terminal);
    },
  );

  // §7.3 and the table in REQUIREMENTS section 3.3
  describe("acceptsReference", () => {
    const of = (kind: Kind) => stored(Status.Processed, kind);
    const accepts: Array<[Kind, Kind[], Kind[]]> = [
      [Kind.Win, [Kind.Bet], [Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback, Kind.Opening]],
      [Kind.Loss, [Kind.Bet], [Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback, Kind.Opening]],
      [Kind.Refund, [Kind.Bet], [Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback, Kind.Opening]],
      [Kind.Rollback, [Kind.Bet, Kind.Win, Kind.Refund], [Kind.Loss, Kind.Rollback, Kind.Opening]],
    ];
    test.each(accepts)("%s", (kind, allowed, refused) => {
      const t = stored(Status.Pending, kind);
      for (const target of allowed) expect(t.acceptsReference(of(target))).toBe(true);
      for (const target of refused) expect(t.acceptsReference(of(target))).toBe(false);
    });

    test("a BET and an OPENING accept nothing", () => {
      for (const kind of [Kind.Bet, Kind.Opening]) {
        for (const target of Object.values(Kind))
          expect(stored(Status.Pending, kind).acceptsReference(of(target))).toBe(false);
      }
    });
  });

  describe("ledgerDirectionFor", () => {
    const of = (kind: Kind) => stored(Status.Processed, kind);

    test("a BET debits; a WIN, REFUND and OPENING credit", () => {
      expect(stored(Status.Pending, Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(stored(Status.Pending, Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(stored(Status.Pending, Kind.Opening).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(stored(Status.Pending, Kind.Refund).ledgerDirectionFor(of(Kind.Bet))).toBe(
        LedgerDirection.Credit,
      );
    });

    // §7: "inverso da referência"
    test("a ROLLBACK inverts its reference", () => {
      const rollback = stored(Status.Pending, Kind.Rollback);
      expect(rollback.ledgerDirectionFor(of(Kind.Bet))).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(of(Kind.Win))).toBe(LedgerDirection.Debit);
      expect(rollback.ledgerDirectionFor(of(Kind.Refund))).toBe(LedgerDirection.Debit);
    });

    test("a LOSS has no direction", () => {
      expect(() => stored(Status.Pending, Kind.Loss).ledgerDirectionFor()).toThrow(
        InvalidWagerTransactionError,
      );
    });

    test("a REFUND or ROLLBACK cannot name a direction without an acceptable reference", () => {
      for (const kind of [Kind.Refund, Kind.Rollback]) {
        const t = stored(Status.Pending, kind);
        expect(() => t.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
        expect(() => t.ledgerDirectionFor(of(Kind.Loss))).toThrow(InvalidWagerTransactionError);
        expect(() => t.ledgerDirectionFor(of(Kind.Opening))).toThrow(InvalidWagerTransactionError);
      }
      expect(() => stored(Status.Pending, Kind.Refund).ledgerDirectionFor(of(Kind.Win))).toThrow(
        InvalidWagerTransactionError,
      );
      expect(() => stored(Status.Pending, Kind.Rollback).ledgerDirectionFor(of(Kind.Rollback))).toThrow(
        InvalidWagerTransactionError,
      );
    });
  });
});

describe("transitions", () => {
  const BALANCE = brl("75.00");
  type Attempt = [string, (t: WagerTransaction) => void];
  const attempts: Attempt[] = [
    ["markProcessed", (t) => t.markProcessed("ref-id", BALANCE, LATER)],
    ["markPendingReference", (t) => t.markPendingReference(BALANCE)],
    ["reject", (t) => t.reject("INSUFFICIENT_FUNDS", BALANCE)],
    ["fail", (t) => t.fail("SETTLEMENT_FAILED")],
  ];

  // FR-30: the lifecycle in REQUIREMENTS section 3.4, as a full matrix.
  const allowed: Record<string, Record<string, boolean>> = {
    [Status.Pending]: { markProcessed: true, markPendingReference: true, reject: true, fail: true },
    [Status.PendingReference]: { markProcessed: true, markPendingReference: false, reject: true, fail: true },
    [Status.Processed]: { markProcessed: false, markPendingReference: false, reject: false, fail: false },
    [Status.Rejected]: { markProcessed: false, markPendingReference: false, reject: false, fail: false },
    [Status.Failed]: { markProcessed: false, markPendingReference: false, reject: false, fail: false },
  };

  for (const [from, row] of Object.entries(allowed)) {
    describe(`from ${from}`, () => {
      for (const [name, run] of attempts) {
        if (row[name]) {
          test(`${name} is allowed`, () => {
            const t = stored(from as Status);
            expect(() => run(t)).not.toThrow();
            expect(t.status).not.toBe(from);
          });
        } else {
          test(`${name} throws and changes nothing`, () => {
            const t = stored(from as Status);
            const before = snapshot(t);
            expect(() => run(t)).toThrow(InvalidTransactionStateError);
            expect(snapshot(t)).toEqual(before);
          });
        }
      }
    });
  }

  test("every terminal state refuses every transition, for every kind", () => {
    for (const kind of Object.values(Kind)) {
      for (const status of [Status.Processed, Status.Rejected, Status.Failed]) {
        for (const [, run] of attempts) {
          expect(() => run(stored(status, kind))).toThrow(InvalidTransactionStateError);
        }
      }
    }
  });

  describe("markProcessed", () => {
    test("records the outcome, the reference link and the balance observed", () => {
      const t = make(Kind.Refund);
      t.markProcessed("ref-id", BALANCE, LATER);
      expect(t.status).toBe(Status.Processed);
      expect(t.referenceTransactionId).toBe("ref-id");
      expect(t.observedBalance?.toString()).toBe("75.00 BRL");
      expect(t.processedAt?.toISOString()).toBe(LATER.toISOString());
      expect(t.failureCode).toBeUndefined();
      expect(t.isTerminal()).toBe(true);
    });

    test("a BET is processed with no reference link", () => {
      const t = make(Kind.Bet);
      t.markProcessed(undefined, BALANCE, LATER);
      expect(t.referenceTransactionId).toBeUndefined();
    });

    // The link is present exactly when a reference was declared.
    test("a transaction that declared a reference cannot be processed without resolving it", () => {
      for (const t of [
        make(Kind.Refund),
        make(Kind.Rollback),
        make(Kind.Win, { referenceExternalTransactionId: "ext-0" }),
      ]) {
        const before = snapshot(t);
        expect(() => t.markProcessed(undefined, BALANCE, LATER)).toThrow(InvalidWagerTransactionError);
        expect(snapshot(t)).toEqual(before);
      }
    });

    test("a transaction that declared none cannot be linked to one", () => {
      for (const t of [make(Kind.Bet), make(Kind.Win), make(Kind.Loss)]) {
        const before = snapshot(t);
        expect(() => t.markProcessed("ref-id", BALANCE, LATER)).toThrow(InvalidWagerTransactionError);
        expect(snapshot(t)).toEqual(before);
      }
    });

    test("a WIN or LOSS that did declare a reference is linked when processed", () => {
      for (const kind of [Kind.Win, Kind.Loss]) {
        const t = make(kind, { referenceExternalTransactionId: "ext-0" });
        t.markProcessed("ref-id", BALANCE, LATER);
        expect(t.referenceTransactionId).toBe("ref-id");
      }
    });

    test("refuses a balance in another currency, a negative one, a bad date, and an empty link, changing nothing", () => {
      const t = make(Kind.Refund);
      const before = snapshot(t);
      const usd = Money.from({ amount: "5.00", currency: "USD" });
      expect(() => t.markProcessed("ref-id", usd, LATER)).toThrow(InvalidWagerTransactionError);
      expect(() => t.markProcessed("ref-id", brl("5.00").negate(), LATER)).toThrow(
        InvalidWagerTransactionError,
      );
      expect(() => t.markProcessed("ref-id", BALANCE, new Date("nope"))).toThrow(
        InvalidWagerTransactionError,
      );
      expect(() => t.markProcessed(" ", BALANCE, LATER)).toThrow(InvalidWagerTransactionError);
      expect(snapshot(t)).toEqual(before);
    });

    test("copies the date it is given, so a caller cannot alter the recorded time", () => {
      const at = new Date(LATER);
      const t = make(Kind.Bet);
      t.markProcessed(undefined, BALANCE, at);
      at.setFullYear(1999);
      expect(t.processedAt?.toISOString()).toBe(LATER.toISOString());
    });

    test("a zero balance is a valid observation", () => {
      const t = make(Kind.Bet);
      t.markProcessed(undefined, brl("0.00"), LATER);
      expect(t.observedBalance?.isZero()).toBe(true);
    });
  });

  describe("markPendingReference", () => {
    test("waits, and keeps the balance observed", () => {
      const t = make(Kind.Rollback);
      t.markPendingReference(BALANCE);
      expect(t.status).toBe(Status.PendingReference);
      expect(t.observedBalance?.toString()).toBe("75.00 BRL");
      expect(t.isTerminal()).toBe(false);
      expect(t.processedAt).toBeUndefined();
    });

    test("a transaction that declared no reference has nothing to wait for", () => {
      for (const t of [make(Kind.Bet), make(Kind.Win), make(Kind.Loss)]) {
        expect(() => t.markPendingReference(BALANCE)).toThrow(InvalidTransactionStateError);
        expect(t.status).toBe(Status.Pending);
      }
    });

    test("a WIN that declared a reference can wait for it", () => {
      const t = make(Kind.Win, { referenceExternalTransactionId: "ext-0" });
      t.markPendingReference(BALANCE);
      expect(t.status).toBe(Status.PendingReference);
    });

    test("refuses an unusable balance, changing nothing", () => {
      const t = make(Kind.Refund);
      expect(() => t.markPendingReference(Money.from({ amount: "1.00", currency: "USD" }))).toThrow(
        InvalidWagerTransactionError,
      );
      expect(t.status).toBe(Status.Pending);
    });
  });

  describe("reject", () => {
    test.each(REJECTION_CODES)("records %s", (code) => {
      const t = make(Kind.Bet);
      t.reject(code, BALANCE);
      expect(t.status).toBe(Status.Rejected);
      expect(t.failureCode).toBe(code);
      expect(t.observedBalance?.toString()).toBe("75.00 BRL");
      expect(t.processedAt).toBeUndefined();
      expect(t.referenceTransactionId).toBeUndefined();
    });

    // FR-58
    test("can record no balance at all, for a response that must not carry one", () => {
      const t = make(Kind.Bet);
      t.reject("PLAYER_WALLET_MISMATCH", undefined);
      expect(t.observedBalance).toBeUndefined();
      expect(t.failureCode).toBe("PLAYER_WALLET_MISMATCH");
    });

    test("can reject a transaction that was waiting for its reference (FR-42)", () => {
      const t = stored(Status.PendingReference);
      t.reject("REFERENCE_NOT_FOUND", BALANCE);
      expect(t.status).toBe(Status.Rejected);
    });

    test("refuses a code that is not a rejection, changing nothing", () => {
      const t = make(Kind.Bet);
      const before = snapshot(t);
      expect(() => t.reject("SETTLEMENT_FAILED" as never, BALANCE)).toThrow(InvalidWagerTransactionError);
      expect(() => t.reject("NOPE" as never, BALANCE)).toThrow(InvalidWagerTransactionError);
      expect(() => t.reject("INSUFFICIENT_FUNDS", brl("1.00").negate())).toThrow(
        InvalidWagerTransactionError,
      );
      expect(snapshot(t)).toEqual(before);
    });
  });

  describe("fail", () => {
    test("records an infrastructure failure, which blames no payload", () => {
      const t = stored(Status.PendingReference);
      t.fail("SETTLEMENT_FAILED");
      expect(t.status).toBe(Status.Failed);
      expect(t.failureCode).toBe("SETTLEMENT_FAILED");
      expect(t.isTerminal()).toBe(true);
    });

    test("refuses a business rejection code, so a fault cannot be reported as the provider's mistake", () => {
      const t = make(Kind.Bet);
      expect(() => t.fail("INSUFFICIENT_FUNDS" as never)).toThrow(InvalidWagerTransactionError);
      expect(t.status).toBe(Status.Pending);
    });
  });
});

describe("rehydrate", () => {
  test("restores any state without validating transitions", () => {
    for (const status of Object.values(Status)) expect(stored(status).status).toBe(status);
  });

  test("restores even a state create() would never produce, and then enforces the lifecycle from there", () => {
    const odd = WagerTransaction.rehydrate({
      ...snapshotState(make(Kind.Bet)),
      status: Status.Processed,
      referenceTransactionId: "dangling",
      processedAt: undefined,
    });
    expect(odd.status).toBe(Status.Processed);
    expect(odd.referenceTransactionId).toBe("dangling");
    expect(() => odd.reject("INSUFFICIENT_FUNDS", undefined)).toThrow(InvalidTransactionStateError);
  });

  test("keeps everything a stored row carries", () => {
    const t = WagerTransaction.rehydrate({
      ...snapshotState(make(Kind.Refund)),
      status: Status.Rejected,
      failureCode: "ALREADY_REVERSED",
      observedBalance: brl("100.00"),
      processedAt: LATER,
    });
    expect(t.failureCode).toBe("ALREADY_REVERSED");
    expect(t.observedBalance?.toString()).toBe("100.00 BRL");
    expect(t.processedAt?.toISOString()).toBe(LATER.toISOString());
  });

  test("copies its dates, in and out", () => {
    const processedAt = new Date(LATER);
    const t = WagerTransaction.rehydrate({
      ...snapshotState(make(Kind.Bet)),
      status: Status.Processed,
      processedAt,
    });
    processedAt.setFullYear(1999);
    t.processedAt?.setFullYear(1999);
    expect(t.processedAt?.toISOString()).toBe(LATER.toISOString());
  });
});

function snapshotState(t: WagerTransaction): WagerTransactionState {
  return {
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
    money: t.money,
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    createdAt: t.createdAt,
    status: t.status,
    referenceTransactionId: t.referenceTransactionId,
    failureCode: t.failureCode,
    observedBalance: t.observedBalance,
    processedAt: t.processedAt,
  };
}
