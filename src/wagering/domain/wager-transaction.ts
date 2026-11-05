import { InvalidTransactionStateError, InvalidWagerTransactionError } from "./errors";
import {
  type FailureCode,
  type InfrastructureFailureCode,
  isInfrastructureFailureCode,
  isRejectionCode,
  type RejectionCode,
} from "./failure-code";
import { assertDate, assertText } from "./guards";
import type { Money } from "./money";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

/** Reserved for OPENING (FR-62): a provider can never claim it, so an opening cannot collide with a real operation. */
export const INTERNAL_PROVIDER_ID = "internal";

const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/** What each kind may point at. A kind absent here takes no reference at all. */
const ACCEPTED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/** The direction a kind moves money when it stands on its own. Rollback is the exception: it inverts its reference. */
const OWN_DIRECTION: Partial<Record<WagerTransactionKind, LedgerDirection>> = {
  [WagerTransactionKind.Opening]: LedgerDirection.Credit,
  [WagerTransactionKind.Bet]: LedgerDirection.Debit,
  [WagerTransactionKind.Win]: LedgerDirection.Credit,
  [WagerTransactionKind.Refund]: LedgerDirection.Credit,
};

const TERMINAL: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** The provider's id for the transaction this one points at, not an internal id. */
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface CreateOpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  /** The wallet balance when the decision was made. Replay returns it (FR-52), and LOSS and REJECTED have no ledger entry to read it from (FR-55). */
  observedBalance: Money | undefined;
  processedAt: Date | undefined;
}

/**
 * One operation from a provider, and what became of it.
 *
 * It is born `PENDING` in memory and stored with its outcome, because HTTP and
 * SQS both settle before they answer (FR-31). `PROCESSED`, `REJECTED` and
 * `FAILED` are terminal (FR-30):
 *
 * ```text
 * PENDING           → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 * PENDING_REFERENCE → PROCESSED | REJECTED | FAILED
 * ```
 *
 * A transition that is not listed throws `InvalidTransactionStateError`. Every
 * transition validates first and only then changes state, so a refusal leaves
 * the transaction as it was.
 */
export class WagerTransaction {
  private readonly _createdAt: Date;
  private _processedAt: Date | undefined;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _observedBalance: Money | undefined,
    processedAt: Date | undefined,
  ) {
    this._createdAt = new Date(createdAt);
    this._processedAt = processedAt ? new Date(processedAt) : undefined;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  /**
   * A provider's operation, born `PENDING`. It cannot make an `OPENING`, so the
   * submit path has no way to create one however the payload is shaped (§6.3).
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    assertText(props.id, "id", InvalidWagerTransactionError);
    assertText(props.providerId, "providerId", InvalidWagerTransactionError);
    assertText(props.externalTransactionId, "externalTransactionId", InvalidWagerTransactionError);
    assertText(props.idempotencyKey, "idempotencyKey", InvalidWagerTransactionError);
    assertText(props.payloadHash, "payloadHash", InvalidWagerTransactionError);
    assertText(props.walletId, "walletId", InvalidWagerTransactionError);
    assertText(props.playerId, "playerId", InvalidWagerTransactionError);
    assertText(props.roundId, "roundId", InvalidWagerTransactionError);
    assertText(props.gameId, "gameId", InvalidWagerTransactionError);
    assertDate(props.createdAt, "createdAt", InvalidWagerTransactionError);

    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING is internal and cannot be submitted");
    }
    if (!SUBMITTABLE_KINDS.includes(props.kind)) {
      throw new InvalidWagerTransactionError(`unknown kind: ${String(props.kind)}`);
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }

    // LOSS moves no money, so zero is its natural amount (INT-05). Everything else must move something.
    if (props.money.isNegative()) throw new InvalidWagerTransactionError("amount cannot be negative");
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${props.kind} needs a positive amount`);
    }

    const reference = props.referenceExternalTransactionId;
    const takesReference = ACCEPTED_REFERENCE_KINDS[props.kind] !== undefined;
    const needsReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (reference !== undefined)
      assertText(reference, "referenceExternalTransactionId", InvalidWagerTransactionError);
    if (needsReference && reference === undefined) {
      throw new InvalidWagerTransactionError(`${props.kind} requires a reference`);
    }
    if (!takesReference && reference !== undefined) {
      throw new InvalidWagerTransactionError(`${props.kind} cannot carry a reference`);
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError("a transaction cannot reference itself");
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  /**
   * The internal credit that funds a new wallet. The keys derive from the wallet,
   * so a second opening for one wallet collides on the idempotency key in the
   * schema, and not only in code.
   */
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    assertText(props.id, "id", InvalidWagerTransactionError);
    assertText(props.walletId, "walletId", InvalidWagerTransactionError);
    assertText(props.playerId, "playerId", InvalidWagerTransactionError);
    assertDate(props.createdAt, "createdAt", InvalidWagerTransactionError);
    if (!props.money.isPositive())
      throw new InvalidWagerTransactionError("an opening must credit a positive amount");

    return new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      `opening-${props.walletId}`,
      `${INTERNAL_PROVIDER_ID}:opening-${props.walletId}`,
      "opening",
      props.walletId,
      props.playerId,
      "opening",
      "opening",
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  /** Rebuilds a stored transaction in any status, without validating transitions: it only restores state that was already valid. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.observedBalance,
      state.processedAt,
    );
  }

  // ---- transitions

  /**
   * Applied. `referenceTransactionId` is the internal id of the resolved
   * reference, and is present exactly when this transaction declared one.
   */
  markProcessed(referenceTransactionId: string | undefined, balance: Money, at: Date): void {
    this.assertCanSettle("PROCESSED");
    assertDate(at, "at", InvalidWagerTransactionError);
    this.assertBalance(balance);
    const declaresReference = this.referenceExternalTransactionId !== undefined;
    if (declaresReference && referenceTransactionId === undefined) {
      throw new InvalidWagerTransactionError(
        "a transaction with a reference needs the resolved reference id to be processed",
      );
    }
    if (!declaresReference && referenceTransactionId !== undefined) {
      throw new InvalidWagerTransactionError("a transaction without a reference cannot be linked to one");
    }
    if (referenceTransactionId !== undefined) {
      assertText(referenceTransactionId, "referenceTransactionId", InvalidWagerTransactionError);
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = balance;
    this._processedAt = new Date(at);
  }

  /** The reference has not arrived yet. Only a first decision can wait, and only a transaction that declared a reference. */
  markPendingReference(balance: Money): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`cannot wait for a reference from ${this._status}`);
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(
        `${this.kind} declared no reference, so there is nothing to wait for`,
      );
    }
    this.assertBalance(balance);

    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = balance;
  }

  /**
   * A business rule refused it. `balance` is absent when the response must not
   * carry one, as for PLAYER_WALLET_MISMATCH, where it belongs to someone else (FR-58).
   */
  reject(code: RejectionCode, balance: Money | undefined): void {
    this.assertCanSettle("REJECTED");
    if (!isRejectionCode(code))
      throw new InvalidWagerTransactionError(`not a rejection code: ${String(code)}`);
    if (balance !== undefined) this.assertBalance(balance);

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = balance;
  }

  /** Infrastructure could not settle it (FR-32). Distinct from a rejection, which blames the payload. */
  fail(code: InfrastructureFailureCode): void {
    this.assertCanSettle("FAILED");
    if (!isInfrastructureFailureCode(code)) {
      throw new InvalidWagerTransactionError(`not an infrastructure failure code: ${String(code)}`);
    }

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL.includes(this._status);
  }

  /** Whether the kind moves money at all. LOSS records an outcome only (§7). */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Whether `reference` is a kind this one may point at. Same-wallet, same-round and amount rules are the policy's. */
  acceptsReference(reference: WagerTransaction): boolean {
    return ACCEPTED_REFERENCE_KINDS[this.kind]?.includes(reference.kind) ?? false;
  }

  /**
   * Which way this transaction moves money. ROLLBACK inverts its reference: it
   * returns a BET's debit and takes back a WIN's or REFUND's credit (§7).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (!this.affectsBalance()) {
      throw new InvalidWagerTransactionError(`${this.kind} has no ledger direction`);
    }
    if (this.requiresReference()) {
      if (!reference)
        throw new InvalidWagerTransactionError(`${this.kind} needs its reference to know its direction`);
      if (!this.acceptsReference(reference)) {
        throw new InvalidWagerTransactionError(`${this.kind} cannot reverse a ${reference.kind}`);
      }
    }
    if (this.kind === WagerTransactionKind.Rollback) {
      // The reference's own direction, never its `ledgerDirectionFor`: a REFUND requires a reference
      // of its own to answer that, but it always credits, whatever it points at.
      const original = OWN_DIRECTION[(reference as WagerTransaction).kind] as LedgerDirection;
      return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
    }
    return OWN_DIRECTION[this.kind] as LedgerDirection;
  }

  private assertCanSettle(target: string): void {
    if (
      this._status !== WagerTransactionStatus.Pending &&
      this._status !== WagerTransactionStatus.PendingReference
    ) {
      throw new InvalidTransactionStateError(`cannot become ${target} from ${this._status}`);
    }
  }

  private assertBalance(balance: Money): void {
    if (balance.currency !== this.money.currency) {
      throw new InvalidWagerTransactionError("the observed balance must be in the transaction's currency");
    }
    if (balance.isNegative())
      throw new InvalidWagerTransactionError("an observed balance can never be negative");
  }
}
