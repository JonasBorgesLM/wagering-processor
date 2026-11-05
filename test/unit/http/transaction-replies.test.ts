import { describe, expect, test } from "bun:test";
import { SettlementFailedError } from "../../../src/wagering/application/errors";
import type { SubmissionResult } from "../../../src/wagering/application/submit-wager-transaction";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/wagering/domain/wager-transaction";
import {
  submissionReply,
  transactionBody,
} from "../../../src/wagering/infrastructure/http/transaction-replies";
import { brl, stored, T0, transaction } from "../../support/domain-fixtures";

const result = (overrides: Partial<SubmissionResult> = {}): SubmissionResult => ({
  transactionId: "tx-1",
  status: Status.Processed,
  failureCode: undefined,
  balance: brl("975.00"),
  idempotentReplay: false,
  ...overrides,
});

describe("each outcome has its own status (§9)", () => {
  test("applied is 200, in the shape of the challenge's example", () => {
    expect(submissionReply(result())).toEqual({
      status: 200,
      body: {
        transactionId: "tx-1",
        status: "PROCESSED",
        idempotentReplay: false,
        balance: { amount: "975.00", currency: "BRL" },
      },
    });
  });

  test("waiting for a reference is 202", () => {
    const reply = submissionReply(result({ status: Status.PendingReference }));
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({ status: "PENDING_REFERENCE", balance: { amount: "975.00" } });
  });

  test("a business rejection is 422, with the reason a provider acts on", () => {
    const reply = submissionReply(result({ status: Status.Rejected, failureCode: "INSUFFICIENT_FUNDS" }));
    expect(reply.status).toBe(422);
    expect(reply.body).toEqual({
      transactionId: "tx-1",
      status: "REJECTED",
      idempotentReplay: false,
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "975.00", currency: "BRL" },
    });
  });

  // The failure mode on the issue: these three must never share a status.
  test("applied, waiting and rejected are three different statuses", () => {
    const statuses = [Status.Processed, Status.PendingReference, Status.Rejected].map(
      (status) =>
        submissionReply(
          result({ status, failureCode: status === Status.Rejected ? "INSUFFICIENT_FUNDS" : undefined }),
        ).status,
    );
    expect(new Set(statuses).size).toBe(3);
  });

  test("none of them is a 4xx that a provider would not resend, or a 5xx that it would", () => {
    expect(submissionReply(result()).status).toBeLessThan(300);
    expect(submissionReply(result({ status: Status.PendingReference })).status).toBeLessThan(300);
    expect(submissionReply(result({ status: Status.Rejected, failureCode: "ALREADY_REVERSED" })).status).toBe(
      422,
    );
  });
});

describe("a replay answers like the original, and says so", () => {
  test.each([
    [Status.Processed, 200],
    [Status.PendingReference, 202],
    [Status.Rejected, 422],
  ] as const)("%s replays as %i", (status, expected) => {
    const reply = submissionReply(
      result({
        status,
        idempotentReplay: true,
        failureCode: status === Status.Rejected ? "ALREADY_REVERSED" : undefined,
      }),
    );
    expect(reply.status).toBe(expected);
    expect(reply.body.idempotentReplay).toBe(true);
  });
});

describe("what is left out", () => {
  test("an applied transaction carries no failure code", () => {
    expect(submissionReply(result()).body).not.toHaveProperty("failureCode");
  });

  // FR-58: the response must not carry a balance it withholds, and must not carry a null in its place.
  test("a rejection that withholds the balance has no balance key at all", () => {
    const reply = submissionReply(
      result({ status: Status.Rejected, failureCode: "PLAYER_WALLET_MISMATCH", balance: undefined }),
    );
    expect(reply.body).not.toHaveProperty("balance");
    expect(JSON.stringify(reply.body)).not.toContain("null");
  });
});

describe("what is not a reply", () => {
  test("a FAILED transaction is an error, because asking again returns the same answer", () => {
    expect(() =>
      submissionReply(result({ status: Status.Failed, failureCode: "SETTLEMENT_FAILED" })),
    ).toThrow(SettlementFailedError);
  });

  test("a stored transaction that is still PENDING is a bug, not a case", () => {
    expect(() => submissionReply(result({ status: Status.Pending }))).toThrow(/PENDING/);
  });
});

describe("a transaction as a provider reads it", () => {
  const processed = () => {
    const t = transaction(Kind.Bet, {
      id: "tx-1",
      externalTransactionId: "ext-1",
      money: brl("25.00"),
      createdAt: T0,
    });
    t.markProcessed(undefined, brl("75.00"), new Date("2026-11-05T13:00:00.000Z"));
    return t;
  };

  test("a processed BET", () => {
    expect(transactionBody(processed())).toEqual({
      transactionId: "tx-1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      walletId: "w1",
      playerId: "p1",
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      status: "PROCESSED",
      balance: { amount: "75.00", currency: "BRL" },
      createdAt: "2026-11-05T12:00:00.000Z",
      processedAt: "2026-11-05T13:00:00.000Z",
    });
  });

  test("a rejection carries its code and when it withheld the balance, no balance", () => {
    const t = transaction(Kind.Bet);
    t.reject("PLAYER_WALLET_MISMATCH", undefined);
    const body = transactionBody(t);
    expect(body.failureCode).toBe("PLAYER_WALLET_MISMATCH");
    expect(body).not.toHaveProperty("balance");
    expect(body).not.toHaveProperty("processedAt");
  });

  test("a waiting reversal names what it waits for", () => {
    const t = transaction(Kind.Refund, { referenceExternalTransactionId: "ext-0" });
    t.markPendingReference(brl("75.00"));
    expect(transactionBody(t)).toMatchObject({
      status: "PENDING_REFERENCE",
      referenceExternalTransactionId: "ext-0",
    });
    expect(transactionBody(t)).not.toHaveProperty("referenceTransactionId");
  });

  test("a processed reversal links the transaction it reversed", () => {
    const t = transaction(Kind.Refund, { referenceExternalTransactionId: "ext-0" });
    t.markProcessed("tx-0", brl("100.00"), T0);
    expect(transactionBody(t)).toMatchObject({
      referenceExternalTransactionId: "ext-0",
      referenceTransactionId: "tx-0",
    });
  });

  test("a field that does not apply is absent, never null", () => {
    expect(JSON.stringify(transactionBody(processed()))).not.toContain("null");
  });

  test("a stored failure shows its infrastructure code", () => {
    expect(
      transactionBody(stored(Kind.Bet, Status.Failed, {}, { failureCode: "SETTLEMENT_FAILED" })).failureCode,
    ).toBe("SETTLEMENT_FAILED");
  });
});
