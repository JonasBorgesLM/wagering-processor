import { Money } from "../../src/wagering/domain/money";
import {
  type CreateWagerTransactionProps,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  WagerTransaction,
  type WagerTransactionState,
} from "../../src/wagering/domain/wager-transaction";
import { Wallet } from "../../src/wagering/domain/wallet";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string) => Money.from({ amount, currency: "USD" });
export const T0 = new Date("2026-11-05T12:00:00.000Z");

export function walletWith(balance: string, overrides: { id?: string; playerId?: string } = {}): Wallet {
  const initialBalance = brl(balance);
  return Wallet.open({
    id: overrides.id ?? "w1",
    playerId: overrides.playerId ?? "p1",
    initialBalance,
    at: T0,
    ...(initialBalance.isZero() ? {} : { opening: { transactionId: "opening-t", entryId: "opening-e" } }),
  }).wallet;
}

let counter = 0;

/** A provider operation with sensible defaults. REFUND and ROLLBACK get a reference unless told otherwise. */
export function transaction(
  kind: Kind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const n = ++counter;
  const needsReference = kind === Kind.Refund || kind === Kind.Rollback;
  return WagerTransaction.create({
    id: `t${n}`,
    providerId: "provider-a",
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `provider-a:ext-${n}`,
    payloadHash: `hash-${n}`,
    walletId: "w1",
    playerId: "p1",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl("80.00"),
    createdAt: T0,
    ...(needsReference ? { referenceExternalTransactionId: "ref-ext" } : {}),
    ...overrides,
  });
}

/** A stored transaction in the given status, as a reference would be when loaded from the database. */
export function stored(
  kind: Kind,
  status: Status,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const base =
    kind === Kind.Opening
      ? WagerTransaction.createOpening({
          id: overrides.id ?? "o1",
          walletId: "w1",
          playerId: "p1",
          money: brl("80.00"),
          createdAt: T0,
        })
      : transaction(kind, { externalTransactionId: "ref-ext", ...refFor(kind), ...overrides });
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

// A stored REFUND or ROLLBACK reference needs a reference of its own to be valid; the value is irrelevant here.
function refFor(kind: Kind): Partial<CreateWagerTransactionProps> {
  return kind === Kind.Refund || kind === Kind.Rollback
    ? { referenceExternalTransactionId: "its-own-ref" }
    : {};
}
