import { describe, expect, test } from "bun:test";
import { ExternalIdConflictError, IdempotencyConflictError } from "../../../src/wagering/application/errors";
import type { TransactionContext, UnitOfWork } from "../../../src/wagering/application/ports";
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from "../../../src/wagering/application/submit-wager-transaction";
import type { IntegrationEvent } from "../../../src/wagering/domain/integration-event";
import {
  WagerTransactionKind as Kind,
  type WagerTransaction,
} from "../../../src/wagering/domain/wager-transaction";
import type { Wallet } from "../../../src/wagering/domain/wallet";
import type { WalletLedgerEntry } from "../../../src/wagering/domain/wallet-ledger-entry";
import { brl, T0, walletWith } from "../../support/domain-fixtures";

// Requirements: FR-50 to FR-54. The idempotency decisions of the settlement use case, in memory: the same key with
// the same payload is a replay, with another payload a conflict, and the provider's id under another key a conflict
// too (§13 asks for these as unit tests). That they hold against a real database, under real races, is the
// integration and concurrency suites' to show; this is the rule on its own.

/** Just enough of a unit of work to hold what the use case writes. No rollback: none of these cases needs one. */
class MemoryUnitOfWork implements UnitOfWork {
  readonly transactions: WagerTransaction[] = [];
  readonly entries: WalletLedgerEntry[] = [];
  readonly events: Array<IntegrationEvent<object>> = [];
  constructor(readonly wallet: Wallet) {}

  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const find = (match: (t: WagerTransaction) => boolean) => this.transactions.find(match);
    return work({
      wallets: {
        lockById: async (id) => (id === this.wallet.id ? this.wallet : undefined),
        insert: async () => undefined,
        save: async () => undefined,
      },
      transactions: {
        findByKey: async (key) => find((t) => t.idempotencyKey === key),
        findByExternalId: async (provider, external) =>
          find((t) => t.providerId === provider && t.externalTransactionId === external),
        findById: async (id) => find((t) => t.id === id),
        isReversed: async () => false,
        insert: async (t) => {
          this.transactions.push(t);
        },
        update: async () => undefined,
        scheduleRetry: async () => undefined,
      },
      ledger: {
        append: async (entry) => {
          this.entries.push(entry);
        },
      },
      inbox: { record: async () => ({ inserted: true }) },
      outbox: {
        enqueue: async (events) => {
          this.events.push(...events);
        },
      },
    });
  }
}

function setUp() {
  const wallet = walletWith("100.00");
  const unitOfWork = new MemoryUnitOfWork(wallet);
  let n = 0;
  const useCase = new SubmitWagerTransaction(unitOfWork, { now: () => T0 }, { next: () => `id-${++n}` });
  const bet = (overrides: Partial<SubmitWagerTransactionCommand> = {}): SubmitWagerTransactionCommand => ({
    idempotencyKey: "provider-a:tx-1",
    providerId: "provider-a",
    externalTransactionId: "tx-1",
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: brl("25.00"),
    correlationId: "c1",
    ...overrides,
  });
  return { wallet, unitOfWork, useCase, bet };
}

describe("the same idempotency key (FR-52, FR-53)", () => {
  test("with the same payload is a replay of the original, and writes nothing more", async () => {
    const { unitOfWork, useCase, bet } = setUp();
    const first = await useCase.execute(bet());
    const again = await useCase.execute(bet({ correlationId: "another request" }));

    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(first.idempotentReplay).toBe(false);
    expect(again.balance?.toJSON()).toEqual({ amount: "75.00", currency: "BRL" });
    expect(unitOfWork.transactions).toHaveLength(1);
    expect(unitOfWork.entries).toHaveLength(1);
    expect(unitOfWork.events).toHaveLength(2);
  });

  test.each([
    ["another amount", { money: brl("26.00") }],
    ["another round", { roundId: "round-2" }],
    ["another kind", { kind: Kind.Win }],
    ["another wallet's player", { playerId: "someone-else" }],
  ])("with %s is a conflict and not a replay, and changes nothing", async (_name, change) => {
    const { wallet, unitOfWork, useCase, bet } = setUp();
    await useCase.execute(bet());
    await expect(useCase.execute(bet(change))).rejects.toThrow(IdempotencyConflictError);
    expect(unitOfWork.transactions).toHaveLength(1);
    expect(wallet.balance.toJSON().amount).toBe("75.00");
  });
});

describe("the provider's own id under another key (FR-54)", () => {
  test("is a conflict, not a second operation", async () => {
    const { unitOfWork, useCase, bet } = setUp();
    await useCase.execute(bet());
    await expect(useCase.execute(bet({ idempotencyKey: "a-different-key" }))).rejects.toThrow(
      ExternalIdConflictError,
    );
    expect(unitOfWork.transactions).toHaveLength(1);
  });

  test("the same id at another provider is another operation", async () => {
    const { unitOfWork, useCase, bet } = setUp();
    await useCase.execute(bet());
    const other = await useCase.execute(bet({ providerId: "provider-b", idempotencyKey: "provider-b:tx-1" }));
    expect(other.idempotentReplay).toBe(false);
    expect(unitOfWork.transactions).toHaveLength(2);
  });
});
