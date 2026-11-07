import { describe, expect, test } from "bun:test";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "../../../src/wagering/domain/errors";
import {
  disclosesBalance,
  REJECTION_CODES,
  type RejectionCode,
} from "../../../src/wagering/domain/failure-code";
import { decideSettlement, type SettlementInput } from "../../../src/wagering/domain/settlement-policy";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from "../../../src/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../../src/wagering/domain/wallet-ledger-entry";
import { brl, stored, transaction, usd, walletWith } from "../../support/domain-fixtures";

// Requirements: FR-20 (the kinds a reversal may point at), FR-24 (a WIN on a reversed BET), SR-05 (PLAYER_WALLET_MISMATCH).

type Overrides = Partial<SettlementInput>;

/** Wallet of 100.00, a REFUND of 80.00, and a PROCESSED BET of 80.00 to point at, unless told otherwise. */
function input(tx: WagerTransaction, overrides: Overrides = {}): SettlementInput {
  return {
    transaction: tx,
    wallet: walletWith("100.00"),
    reference: undefined,
    referenceAlreadyReversed: false,
    ...overrides,
  };
}

const bet = (status: Status = Status.Processed) => stored(Kind.Bet, status);

describe("steps 3 and 4: who and what currency", () => {
  test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])(
    "%s for another player is PLAYER_WALLET_MISMATCH, and discloses no balance (FR-58)",
    (kind) => {
      expect(decideSettlement(input(transaction(kind, { playerId: "p2" })))).toEqual({
        outcome: "reject",
        code: "PLAYER_WALLET_MISMATCH",
        observedBalance: undefined,
      });
    },
  );

  test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])(
    "%s in another currency is CURRENCY_MISMATCH, with no balance to record",
    (kind) => {
      const decision = decideSettlement(input(transaction(kind, { money: usd("80.00") })));
      expect(decision).toEqual({ outcome: "reject", code: "CURRENCY_MISMATCH", observedBalance: undefined });
    },
  );

  test("the player is checked before the currency", () => {
    const decision = decideSettlement(input(transaction(Kind.Bet, { playerId: "p2", money: usd("80.00") })));
    expect(decision).toMatchObject({ code: "PLAYER_WALLET_MISMATCH" });
  });

  test("the currency is checked before a missing reference is waited for", () => {
    const decision = decideSettlement(input(transaction(Kind.Rollback, { money: usd("80.00") })));
    expect(decision).toMatchObject({ outcome: "reject", code: "CURRENCY_MISMATCH" });
  });
});

describe("step 5: no reference declared", () => {
  test.each([Kind.Bet, Kind.Win, Kind.Loss])("%s goes straight to the balance check", (kind) => {
    expect(decideSettlement(input(transaction(kind)))).toMatchObject({ outcome: "apply" });
  });
});

describe("step 6: reference not found", () => {
  test.each([Kind.Refund, Kind.Rollback])("%s waits, and records the balance it saw", (kind) => {
    expect(decideSettlement(input(transaction(kind)))).toEqual({
      outcome: "wait-reference",
      observedBalance: brl("100.00"),
    });
  });

  test.each([Kind.Win, Kind.Loss])("a %s that declared a reference waits for it too", (kind) => {
    const tx = transaction(kind, { referenceExternalTransactionId: "ref-ext" });
    expect(decideSettlement(input(tx))).toMatchObject({ outcome: "wait-reference" });
  });
});

describe("step 7: the reference must belong to the same provider, player, wallet, currency and round", () => {
  const cases: Array<[string, Partial<Parameters<typeof stored>[2]>]> = [
    ["provider", { providerId: "provider-b" }],
    ["player", { playerId: "p2" }],
    ["wallet", { walletId: "w2" }],
    ["currency", { money: usd("80.00") }],
    ["round", { roundId: "round-2" }],
  ];
  test.each(cases)("a reference from another %s is REFERENCE_MISMATCH", (_field, overrides) => {
    const reference = stored(Kind.Bet, Status.Processed, overrides);
    const decision = decideSettlement(input(transaction(Kind.Refund), { reference }));
    expect(decision).toEqual({
      outcome: "reject",
      code: "REFERENCE_MISMATCH",
      observedBalance: brl("100.00"),
    });
  });

  test("a matching reference passes this step", () => {
    expect(decideSettlement(input(transaction(Kind.Refund), { reference: bet() }))).toMatchObject({
      outcome: "apply",
    });
  });
});

describe("step 8: the reference must be a kind this one may point at (§7.3)", () => {
  const refused: Array<[Kind, Kind]> = [
    [Kind.Refund, Kind.Win],
    [Kind.Refund, Kind.Refund],
    [Kind.Refund, Kind.Loss],
    [Kind.Rollback, Kind.Loss],
    [Kind.Rollback, Kind.Rollback],
    [Kind.Win, Kind.Refund],
    [Kind.Loss, Kind.Win],
  ];
  test.each(refused)("%s pointing at a %s is REFERENCE_KIND_NOT_ALLOWED", (kind, target) => {
    const reference = stored(target, Status.Processed);
    const tx = transaction(kind, { referenceExternalTransactionId: reference.externalTransactionId });
    const decision = decideSettlement(input(tx, { reference }));
    expect(decision).toMatchObject({ outcome: "reject", code: "REFERENCE_KIND_NOT_ALLOWED" });
  });

  const allowed: Array<[Kind, Kind]> = [
    [Kind.Refund, Kind.Bet],
    [Kind.Rollback, Kind.Bet],
    [Kind.Rollback, Kind.Win],
    [Kind.Rollback, Kind.Refund],
    [Kind.Win, Kind.Bet],
    [Kind.Loss, Kind.Bet],
  ];
  test.each(allowed)("%s pointing at a %s is accepted", (kind, target) => {
    const tx = transaction(kind, { referenceExternalTransactionId: "ref-ext" });
    const decision = decideSettlement(input(tx, { reference: stored(target, Status.Processed) }));
    expect(decision).toMatchObject({ outcome: "apply" });
  });

  // An OPENING belongs to the internal provider and the "opening" round, so it can never match a provider's
  // transaction. In practice a provider's lookup is scoped to its own id and never finds it at all.
  test("an OPENING is never a valid reference: it is a mismatch before its kind is even looked at", () => {
    const reference = stored(Kind.Opening, Status.Processed);
    const tx = transaction(Kind.Rollback, {
      referenceExternalTransactionId: reference.externalTransactionId,
    });
    expect(decideSettlement(input(tx, { reference }))).toMatchObject({
      outcome: "reject",
      code: "REFERENCE_MISMATCH",
    });
  });

  test("the reference's own status does not matter yet: kind is checked first", () => {
    const decision = decideSettlement(
      input(transaction(Kind.Rollback), { reference: stored(Kind.Loss, Status.Rejected) }),
    );
    expect(decision).toMatchObject({ code: "REFERENCE_KIND_NOT_ALLOWED" });
  });

  test("mismatch is checked before kind", () => {
    const reference = stored(Kind.Win, Status.Processed, { roundId: "round-2" });
    expect(decideSettlement(input(transaction(Kind.Refund), { reference }))).toMatchObject({
      code: "REFERENCE_MISMATCH",
    });
  });
});

describe("step 9: the reference must itself have been applied", () => {
  test.each([Status.Pending, Status.PendingReference])("a %s reference keeps this one waiting", (status) => {
    const decision = decideSettlement(input(transaction(Kind.Refund), { reference: bet(status) }));
    expect(decision).toEqual({ outcome: "wait-reference", observedBalance: brl("100.00") });
  });

  // The chain case from issue #19: a reversal waiting on a reversal that is itself waiting.
  test("a ROLLBACK of a REFUND that is still waiting for its own BET keeps waiting", () => {
    const waitingRefund = stored(Kind.Refund, Status.PendingReference);
    expect(decideSettlement(input(transaction(Kind.Rollback), { reference: waitingRefund }))).toMatchObject({
      outcome: "wait-reference",
    });
  });

  test.each([Status.Rejected, Status.Failed])(
    "a %s reference can never be reversed: REFERENCE_NOT_PROCESSED",
    (status) => {
      const decision = decideSettlement(input(transaction(Kind.Refund), { reference: bet(status) }));
      expect(decision).toEqual({
        outcome: "reject",
        code: "REFERENCE_NOT_PROCESSED",
        observedBalance: brl("100.00"),
      });
    },
  );

  test("waiting wins over an amount mismatch, because the amount can only be judged once it is applied", () => {
    const decision = decideSettlement(
      input(transaction(Kind.Refund, { money: brl("50.00") }), { reference: bet(Status.PendingReference) }),
    );
    expect(decision).toMatchObject({ outcome: "wait-reference" });
  });

  test("a rejected reference wins over an already-reversed flag", () => {
    const decision = decideSettlement(
      input(transaction(Kind.Refund), { reference: bet(Status.Rejected), referenceAlreadyReversed: true }),
    );
    expect(decision).toMatchObject({ code: "REFERENCE_NOT_PROCESSED" });
  });
});

describe("step 10: amount and single reversal", () => {
  test.each([Kind.Refund, Kind.Rollback])("a %s must equal its reference to the cent (§7.5)", (kind) => {
    for (const amount of ["79.99", "80.01", "50.00"]) {
      const decision = decideSettlement(
        input(transaction(kind, { money: brl(amount) }), { reference: bet() }),
      );
      expect(decision).toEqual({
        outcome: "reject",
        code: "REFERENCE_AMOUNT_MISMATCH",
        observedBalance: brl("100.00"),
      });
    }
  });

  test.each([Kind.Refund, Kind.Rollback, Kind.Win])(
    "a %s on a reversed reference is ALREADY_REVERSED",
    (kind) => {
      const tx = transaction(kind, { referenceExternalTransactionId: "ref-ext" });
      const decision = decideSettlement(input(tx, { reference: bet(), referenceAlreadyReversed: true }));
      expect(decision).toEqual({
        outcome: "reject",
        code: "ALREADY_REVERSED",
        observedBalance: brl("100.00"),
      });
    },
  );

  // INT-09 names the WIN only. A LOSS records an outcome and moves nothing, so there is no money to protect.
  test("a LOSS on a reversed BET is still recorded", () => {
    const tx = transaction(Kind.Loss, { referenceExternalTransactionId: "ref-ext", money: brl("0.00") });
    expect(decideSettlement(input(tx, { reference: bet(), referenceAlreadyReversed: true }))).toMatchObject({
      outcome: "apply",
    });
  });

  test("a WIN may differ in amount from its BET: only reversals must match", () => {
    const tx = transaction(Kind.Win, { referenceExternalTransactionId: "ref-ext", money: brl("500.00") });
    expect(decideSettlement(input(tx, { reference: bet() }))).toMatchObject({ outcome: "apply" });
  });

  test("the amount is judged before the reversal count", () => {
    const decision = decideSettlement(
      input(transaction(Kind.Refund, { money: brl("50.00") }), {
        reference: bet(),
        referenceAlreadyReversed: true,
      }),
    );
    expect(decision).toMatchObject({ code: "REFERENCE_AMOUNT_MISMATCH" });
  });
});

describe("step 11: the balance", () => {
  test("a BET the balance cannot cover is INSUFFICIENT_FUNDS, and the exact balance is covered", () => {
    expect(decideSettlement(input(transaction(Kind.Bet, { money: brl("100.01") })))).toEqual({
      outcome: "reject",
      code: "INSUFFICIENT_FUNDS",
      observedBalance: brl("100.00"),
    });
    expect(decideSettlement(input(transaction(Kind.Bet, { money: brl("100.00") })))).toMatchObject({
      outcome: "apply",
    });
  });

  // §7.9: operationally different from a bet without funds, so the code must differ.
  test.each([Kind.Win, Kind.Refund])(
    "a ROLLBACK of a %s that the balance cannot cover is REVERSAL_INSUFFICIENT_FUNDS",
    (target) => {
      const decision = decideSettlement(
        input(transaction(Kind.Rollback), {
          wallet: walletWith("79.99"),
          reference: stored(target, Status.Processed),
        }),
      );
      expect(decision).toEqual({
        outcome: "reject",
        code: "REVERSAL_INSUFFICIENT_FUNDS",
        observedBalance: brl("79.99"),
      });
    },
  );

  test("the two shortfall codes are different codes", () => {
    const shortBet = decideSettlement(input(transaction(Kind.Bet), { wallet: walletWith("1.00") }));
    const shortRollback = decideSettlement(
      input(transaction(Kind.Rollback), {
        wallet: walletWith("1.00"),
        reference: stored(Kind.Win, Status.Processed),
      }),
    );
    expect(shortBet).toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(shortRollback).toMatchObject({ code: "REVERSAL_INSUFFICIENT_FUNDS" });
  });

  test.each([
    ["WIN", () => transaction(Kind.Win), undefined],
    ["REFUND of a BET", () => transaction(Kind.Refund), bet()],
    ["ROLLBACK of a BET", () => transaction(Kind.Rollback), bet()],
  ] as const)(
    "a credit that would outgrow the column is BALANCE_LIMIT_EXCEEDED: %s",
    (_name, make, reference) => {
      const decision = decideSettlement(
        input(make(), { wallet: walletWith("999999999999999999.99"), reference }),
      );
      expect(decision).toMatchObject({ outcome: "reject", code: "BALANCE_LIMIT_EXCEEDED" });
    },
  );

  test("a LOSS never checks the balance: it moves nothing", () => {
    const tx = transaction(Kind.Loss, { money: brl("1000000.00") });
    expect(decideSettlement(input(tx, { wallet: walletWith("1.00") }))).toMatchObject({ outcome: "apply" });
  });

  test("the reference checks come before the balance checks", () => {
    const decision = decideSettlement(
      input(transaction(Kind.Rollback), {
        wallet: walletWith("999999999999999999.99"),
        reference: bet(),
        referenceAlreadyReversed: true,
      }),
    );
    expect(decision).toMatchObject({ code: "ALREADY_REVERSED" });
  });
});

describe("step 12: what applying means", () => {
  test("a BET debits, with no reference link", () => {
    expect(decideSettlement(input(transaction(Kind.Bet)))).toEqual({
      outcome: "apply",
      direction: LedgerDirection.Debit,
      referenceTransactionId: undefined,
    });
  });

  test("a WIN credits, and links its BET when it named one", () => {
    expect(decideSettlement(input(transaction(Kind.Win)))).toMatchObject({
      direction: LedgerDirection.Credit,
    });
    const reference = bet();
    const tx = transaction(Kind.Win, { referenceExternalTransactionId: "ref-ext" });
    expect(decideSettlement(input(tx, { reference }))).toEqual({
      outcome: "apply",
      direction: LedgerDirection.Credit,
      referenceTransactionId: reference.id,
    });
  });

  test("a LOSS applies with no direction at all, so no ledger entry follows", () => {
    expect(decideSettlement(input(transaction(Kind.Loss, { money: brl("0.00") })))).toEqual({
      outcome: "apply",
      direction: undefined,
      referenceTransactionId: undefined,
    });
  });

  test("a REFUND credits and links its BET", () => {
    const reference = bet();
    expect(decideSettlement(input(transaction(Kind.Refund), { reference }))).toEqual({
      outcome: "apply",
      direction: LedgerDirection.Credit,
      referenceTransactionId: reference.id,
    });
  });

  test("a ROLLBACK inverts its reference (§7)", () => {
    const direction = (target: Kind) =>
      (
        decideSettlement(
          input(transaction(Kind.Rollback), { reference: stored(target, Status.Processed) }),
        ) as { direction: LedgerDirection }
      ).direction;
    expect(direction(Kind.Bet)).toBe(LedgerDirection.Credit);
    expect(direction(Kind.Win)).toBe(LedgerDirection.Debit);
    expect(direction(Kind.Refund)).toBe(LedgerDirection.Debit);
  });

  test("a waiting transaction is applied once its reference arrives", () => {
    const waiting = stored(Kind.Refund, Status.PendingReference, {
      externalTransactionId: "waiting-ext",
      referenceExternalTransactionId: "ref-ext",
    });
    expect(decideSettlement(input(waiting, { reference: bet() }))).toMatchObject({ outcome: "apply" });
  });
});

describe("every rejection code is reachable, and only those", () => {
  const scenarios: Array<[RejectionCode, () => SettlementInput]> = [
    ["INSUFFICIENT_FUNDS", () => input(transaction(Kind.Bet), { wallet: walletWith("1.00") })],
    [
      "REVERSAL_INSUFFICIENT_FUNDS",
      () =>
        input(transaction(Kind.Rollback), {
          wallet: walletWith("1.00"),
          reference: stored(Kind.Win, Status.Processed),
        }),
    ],
    ["CURRENCY_MISMATCH", () => input(transaction(Kind.Bet, { money: usd("1.00") }))],
    ["PLAYER_WALLET_MISMATCH", () => input(transaction(Kind.Bet, { playerId: "p2" }))],
    ["REFERENCE_NOT_FOUND", () => input(transaction(Kind.Bet))], // produced by the retry worker on expiry, not by the policy
    [
      "REFERENCE_MISMATCH",
      () =>
        input(transaction(Kind.Refund), { reference: stored(Kind.Bet, Status.Processed, { roundId: "x" }) }),
    ],
    [
      "REFERENCE_KIND_NOT_ALLOWED",
      () => input(transaction(Kind.Refund), { reference: stored(Kind.Win, Status.Processed) }),
    ],
    ["REFERENCE_NOT_PROCESSED", () => input(transaction(Kind.Refund), { reference: bet(Status.Rejected) })],
    [
      "REFERENCE_AMOUNT_MISMATCH",
      () => input(transaction(Kind.Refund, { money: brl("1.00") }), { reference: bet() }),
    ],
    [
      "ALREADY_REVERSED",
      () => input(transaction(Kind.Refund), { reference: bet(), referenceAlreadyReversed: true }),
    ],
    [
      "BALANCE_LIMIT_EXCEEDED",
      () => input(transaction(Kind.Win), { wallet: walletWith("999999999999999999.99") }),
    ],
  ];

  // REFERENCE_NOT_FOUND is the one code the policy never returns: a missing reference waits, and only the
  // worker rejects it once the time limit passes (FR-42). Every other code must come from here.
  const WORKER_ONLY: RejectionCode[] = ["REFERENCE_NOT_FOUND"];

  test.each(scenarios.filter(([code]) => !WORKER_ONLY.includes(code)))("produces %s", (code, build) => {
    expect(decideSettlement(build())).toMatchObject({ outcome: "reject", code });
  });

  test("the policy returns REFERENCE_NOT_FOUND for no input: a missing reference waits instead", () => {
    expect(decideSettlement(input(transaction(Kind.Refund)))).toMatchObject({ outcome: "wait-reference" });
  });

  test("the scenarios cover the whole taxonomy, so a new code cannot be added without a case", () => {
    expect(scenarios.map(([code]) => code).sort()).toEqual([...REJECTION_CODES].sort());
  });
});

describe("balance disclosure (FR-58)", () => {
  test("only a wrong player or a wrong currency withholds the balance", () => {
    const withheld = REJECTION_CODES.filter((code) => !disclosesBalance(code));
    expect(withheld.sort()).toEqual(["CURRENCY_MISMATCH", "PLAYER_WALLET_MISMATCH"]);
  });
});

describe("purity", () => {
  test("the same input always gives the same decision", () => {
    const build = () => input(transaction(Kind.Refund), { reference: bet(), referenceAlreadyReversed: true });
    const one = build();
    expect(decideSettlement(one)).toEqual(decideSettlement(one));
  });

  test("it changes nothing: the wallet and both transactions are as they were", () => {
    const wallet = walletWith("100.00");
    const tx = transaction(Kind.Refund);
    const reference = bet();
    const before = JSON.stringify([wallet.balance, wallet.version, tx.status, reference.status]);
    decideSettlement({ transaction: tx, wallet, reference, referenceAlreadyReversed: false });
    expect(JSON.stringify([wallet.balance, wallet.version, tx.status, reference.status])).toBe(before);
  });
});

describe("misuse is a bug, not a business outcome", () => {
  test.each([Status.Processed, Status.Rejected, Status.Failed])(
    "a %s transaction cannot be settled again",
    (status) => {
      expect(() => decideSettlement(input(stored(Kind.Bet, status)))).toThrow(InvalidTransactionStateError);
    },
  );

  test("an OPENING is never settled", () => {
    expect(() => decideSettlement(input(stored(Kind.Opening, Status.Pending)))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("the wallet must be the one the transaction names", () => {
    expect(() =>
      decideSettlement(input(transaction(Kind.Bet), { wallet: walletWith("100.00", { id: "w2" }) })),
    ).toThrow(InvalidWagerTransactionError);
  });

  test("a reference for a transaction that declared none", () => {
    expect(() => decideSettlement(input(transaction(Kind.Bet), { reference: bet() }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("a reference that is not the declared one", () => {
    const wrong = stored(Kind.Bet, Status.Processed, { externalTransactionId: "someone-else" });
    expect(() => decideSettlement(input(transaction(Kind.Refund), { reference: wrong }))).toThrow(
      InvalidWagerTransactionError,
    );
  });
});
