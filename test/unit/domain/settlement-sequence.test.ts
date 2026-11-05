import { describe, expect, test } from "bun:test";
import type { RejectionCode } from "../../../src/wagering/domain/failure-code";
import type { Money } from "../../../src/wagering/domain/money";
import { decideSettlement } from "../../../src/wagering/domain/settlement-policy";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  WagerTransaction,
} from "../../../src/wagering/domain/wager-transaction";
import { Wallet } from "../../../src/wagering/domain/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../../src/wagering/domain/wallet-ledger-entry";
import { brl, T0 } from "../../support/domain-fixtures";

// The worked sequence of REQUIREMENTS section 3.3.1, run end to end through the domain: each line
// continues from the one before it, and the balance after every line is checked.
//
// The harness below does what the settlement use case will do, in memory, so the rules are proven
// before any database exists. It is a stand-in: locking, the inbox and the outbox are issue #12's.

const PROVIDER = "provider-a";

class World {
  readonly wallet: Wallet;
  readonly entries: WalletLedgerEntry[] = [];
  private readonly byExternalId = new Map<string, WagerTransaction>();
  private readonly byKey = new Map<string, WagerTransaction>();
  private readonly reversed = new Set<string>();
  private n = 0;

  constructor(balance = "100.00") {
    // The opening entry belongs to the ledger the balance is rebuilt from.
    const opened = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: brl(balance),
      at: T0,
      opening: { transactionId: "opening-t", entryId: "opening-e" },
    });
    this.wallet = opened.wallet;
    if (opened.openingEntry) this.entries.push(opened.openingEntry);
  }

  find(name: string): WagerTransaction | undefined {
    return this.byExternalId.get(name);
  }

  submit(name: string, kind: Kind, amount: string, referenceName?: string): WagerTransaction {
    const key = `${PROVIDER}:${name}`;
    const hash = `${kind}|${amount}|${referenceName ?? ""}`;

    // Idempotency stand-in: the same key and payload is a replay and touches nothing (FR-52).
    const existing = this.byKey.get(key);
    if (existing?.matchesPayload(hash)) return existing;

    const tx = WagerTransaction.create({
      id: `id-${name}`,
      providerId: PROVIDER,
      externalTransactionId: name,
      idempotencyKey: key,
      payloadHash: hash,
      walletId: "w1",
      playerId: "p1",
      roundId: "round-1",
      gameId: "game-1",
      kind,
      money: brl(amount),
      referenceExternalTransactionId: referenceName,
      createdAt: T0,
    });
    const reference = referenceName ? this.byExternalId.get(referenceName) : undefined;
    const decision = decideSettlement({
      transaction: tx,
      wallet: this.wallet,
      reference,
      referenceAlreadyReversed: reference ? this.reversed.has(reference.id) : false,
    });

    switch (decision.outcome) {
      case "apply": {
        const movement = { transactionId: tx.id, entryId: `e-${++this.n}`, at: T0 };
        if (decision.direction === LedgerDirection.Debit)
          this.entries.push(this.wallet.debit(tx.money, movement));
        if (decision.direction === LedgerDirection.Credit)
          this.entries.push(this.wallet.credit(tx.money, movement));
        tx.markProcessed(decision.referenceTransactionId, this.wallet.balance, T0);
        if (tx.requiresReference() && decision.referenceTransactionId) {
          this.reversed.add(decision.referenceTransactionId);
        }
        break;
      }
      case "reject":
        tx.reject(decision.code, decision.observedBalance);
        break;
      case "wait-reference":
        tx.markPendingReference(decision.observedBalance);
        break;
    }
    this.byExternalId.set(name, tx);
    this.byKey.set(key, tx);
    return tx;
  }
}

interface Step {
  name: string;
  kind: Kind;
  amount: string;
  reference?: string;
  status: Status;
  code?: RejectionCode;
  balance: string;
  /** The same transaction as an earlier line, sent again. */
  replayOf?: string;
}

// One line per row of the table in REQUIREMENTS section 3.3.1.
const SEQUENCE: Step[] = [
  { name: "b1", kind: Kind.Bet, amount: "80.00", status: Status.Processed, balance: "20.00" },
  {
    name: "r1",
    kind: Kind.Refund,
    amount: "50.00",
    reference: "b1",
    status: Status.Rejected,
    code: "REFERENCE_AMOUNT_MISMATCH",
    balance: "20.00",
  },
  {
    name: "r2",
    kind: Kind.Refund,
    amount: "80.00",
    reference: "b1",
    status: Status.Processed,
    balance: "100.00",
  },
  {
    name: "r3",
    kind: Kind.Refund,
    amount: "80.00",
    reference: "b1",
    status: Status.Rejected,
    code: "ALREADY_REVERSED",
    balance: "100.00",
  },
  {
    name: "x1",
    kind: Kind.Rollback,
    amount: "80.00",
    reference: "b1",
    status: Status.Rejected,
    code: "ALREADY_REVERSED",
    balance: "100.00",
  },
  {
    name: "r2",
    kind: Kind.Refund,
    amount: "80.00",
    reference: "b1",
    status: Status.Processed,
    balance: "100.00",
    replayOf: "r2",
  },
  {
    name: "x2",
    kind: Kind.Rollback,
    amount: "80.00",
    reference: "r2",
    status: Status.Processed,
    balance: "20.00",
  },
  {
    name: "x3",
    kind: Kind.Rollback,
    amount: "80.00",
    reference: "x2",
    status: Status.Rejected,
    code: "REFERENCE_KIND_NOT_ALLOWED",
    balance: "20.00",
  },
  {
    name: "w1",
    kind: Kind.Win,
    amount: "500.00",
    reference: "b1",
    status: Status.Rejected,
    code: "ALREADY_REVERSED",
    balance: "20.00",
  },
  { name: "w2", kind: Kind.Win, amount: "500.00", status: Status.Processed, balance: "520.00" },
  { name: "b2", kind: Kind.Bet, amount: "510.00", status: Status.Processed, balance: "10.00" },
  {
    name: "x4",
    kind: Kind.Rollback,
    amount: "500.00",
    reference: "w2",
    status: Status.Rejected,
    code: "REVERSAL_INSUFFICIENT_FUNDS",
    balance: "10.00",
  },
  {
    name: "l1",
    kind: Kind.Loss,
    amount: "0.00",
    reference: "b2",
    status: Status.Processed,
    balance: "10.00",
  },
  // A ROLLBACK cannot be zero, and the kind is refused before any amount is compared, so 1.00 stands for "any".
  {
    name: "x5",
    kind: Kind.Rollback,
    amount: "1.00",
    reference: "l1",
    status: Status.Rejected,
    code: "REFERENCE_KIND_NOT_ALLOWED",
    balance: "10.00",
  },
  {
    name: "r4",
    kind: Kind.Refund,
    amount: "500.00",
    reference: "w2",
    status: Status.Rejected,
    code: "REFERENCE_KIND_NOT_ALLOWED",
    balance: "10.00",
  },
  {
    name: "x6",
    kind: Kind.Rollback,
    amount: "10.00",
    reference: "not-yet-arrived",
    status: Status.PendingReference,
    balance: "10.00",
  },
];

describe("the worked REFUND and ROLLBACK sequence (REQUIREMENTS section 3.3.1)", () => {
  test("every line gives the documented result and balance, and the ledger explains the final balance", () => {
    const world = new World();

    for (const step of SEQUENCE) {
      const before = { version: world.wallet.version, entries: world.entries.length };
      const original = step.replayOf ? world.find(step.replayOf) : undefined;
      const tx = world.submit(step.name, step.kind, step.amount, step.reference);
      const label = `${step.name} (${step.kind})`;

      expect(tx.status, `${label} status`).toBe(step.status);
      expect(tx.failureCode, `${label} code`).toBe(step.code);
      expect(world.wallet.balance.toJSON().amount, `${label} balance`).toBe(step.balance);
      // The balance observed is stored on the transaction, for those that move nothing too (FR-55).
      expect(tx.observedBalance?.toJSON().amount, `${label} observed balance`).toBe(step.balance);

      if (step.replayOf) {
        // A replay is the very same answer, and touches nothing (FR-52).
        expect(original, `${label} has an original`).toBeDefined();
        if (original) expect(tx, `${label} is the original`).toBe(original);
        expect({ version: world.wallet.version, entries: world.entries.length }).toEqual(before);
      }
    }

    // Waiting is not final, and a rejection is.
    expect(world.find("x6")?.isTerminal()).toBe(false);
    expect(world.find("x1")?.isTerminal()).toBe(true);

    // balance == balance rebuilt from the ledger (§13)
    let rebuilt: Money = brl("0.00");
    for (const entry of world.entries) {
      expect(entry.isBalanced()).toBe(true);
      rebuilt =
        entry.direction === LedgerDirection.Credit ? rebuilt.add(entry.money) : rebuilt.subtract(entry.money);
    }
    expect(rebuilt.equals(world.wallet.balance)).toBe(true);

    // Entries: the opening, then b1, r2, x2, w2, b2. Nothing else moved money.
    expect(world.entries).toHaveLength(6);
    expect(world.entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4, 5, 6]);
    // The LOSS and every rejection left the version alone (FR-13).
    expect(world.wallet.version).toBe(6);
  });

  test("a reversal refused for want of funds did not use up its reference, so it can be sent again (FR-27)", () => {
    const world = new World();
    world.submit("b1", Kind.Bet, "80.00");
    world.submit("w2", Kind.Win, "500.00");
    world.submit("b2", Kind.Bet, "510.00");
    expect(world.submit("x4", Kind.Rollback, "500.00", "w2").failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");

    world.submit("w3", Kind.Win, "1000.00"); // 10.00 + 1000.00 = 1010.00, then the rollback takes 500.00
    const again = world.submit("x4-again", Kind.Rollback, "500.00", "w2");
    expect(again.status).toBe(Status.Processed);
    expect(world.wallet.balance.toJSON().amount).toBe("510.00");
  });

  test("a reversal that waited is applied once its reference arrives (FR-40)", () => {
    const world = new World();
    const waiting = world.submit("x1", Kind.Rollback, "80.00", "b1");
    expect(waiting.status).toBe(Status.PendingReference);
    expect(world.entries).toHaveLength(1);

    world.submit("b1", Kind.Bet, "80.00");
    expect(world.wallet.balance.toJSON().amount).toBe("20.00");

    // What the retry worker will do: the same decision again, now with the reference present.
    const retried = decideSettlement({
      transaction: waiting,
      wallet: world.wallet,
      reference: world.find("b1"),
      referenceAlreadyReversed: false,
    });
    expect(retried).toMatchObject({ outcome: "apply", direction: LedgerDirection.Credit });
  });
});
