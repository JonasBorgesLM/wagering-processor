import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { IdempotencyConflictError } from "../../src/wagering/application/errors";
import { SettleWaitingReferences } from "../../src/wagering/application/settle-waiting-references";
import { WagerTransactionKind as Kind } from "../../src/wagering/domain/wager-transaction";
import { MikroOrmPendingReferenceStore } from "../../src/wagering/infrastructure/persistence/mikro-orm-pending-reference-store";
import { brl, command, SettlementWorld } from "../support/settlement";

// Requirements: FR-26 to FR-29, FR-52, FR-53, NFR-01, NFR-05.
// Random sequences of BET, WIN, LOSS, REFUND and ROLLBACK on a few wallets, with reversals sent before what they
// reverse, duplicates resent, and the reference worker run in between, through the real use case on a real
// PostgreSQL (issue #54). Every answer is compared with a small reference model written from the rules of
// REQUIREMENTS section 3.3.1 and nothing else, and every sequence ends on balance == ledger rebuild.
//
// A failure prints its seed:   MODEL_SEED=<seed> bun test test/integration/settlement-model.test.ts
// MODEL_RUNS sets how many seeds a run tries (default 20).

setDefaultTimeout(120_000);

type Name = string;
type Status = "PROCESSED" | "REJECTED" | "PENDING_REFERENCE";
type MTx = Spec & Outcome & { reversedBy?: Name };

interface Spec {
  name: Name;
  wallet: number;
  kind: Kind;
  cents: bigint;
  round: string;
  ref?: Name;
}

interface Outcome {
  status: Status;
  code?: string | undefined;
}

const ACCEPTS: Partial<Record<Kind, Kind[]>> = {
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};
const isReversal = (kind: Kind) => kind === Kind.Refund || kind === Kind.Rollback;

/** The rules, as a table would state them. Deliberately not the domain's code: if both are wrong the same way, so be it. */
class Model {
  readonly balance: bigint[];
  private readonly txs = new Map<Name, MTx>();
  private readonly order: Name[] = [];

  constructor(wallets: number, opening: bigint) {
    this.balance = Array.from({ length: wallets }, () => opening);
  }

  known(name: Name): (Spec & Outcome) | undefined {
    return this.txs.get(name);
  }

  /** A first arrival. */
  submit(spec: Spec): Outcome {
    const tx: MTx = { ...spec, status: "PENDING_REFERENCE" };
    this.txs.set(spec.name, tx);
    this.order.push(spec.name);
    this.settle(tx);
    return { status: tx.status, code: tx.code };
  }

  /** One sweep of the reference worker over what is waiting, oldest first. Whether anything changed. */
  sweep(): boolean {
    let changed = false;
    for (const name of this.order) {
      const tx = this.txs.get(name);
      if (tx?.status !== "PENDING_REFERENCE") continue;
      this.settle(tx);
      if (tx.status !== "PENDING_REFERENCE") changed = true;
    }
    return changed;
  }

  all(): Array<Spec & Outcome> {
    return this.order.map((name) => this.txs.get(name) as Spec & Outcome);
  }

  private settle(tx: MTx): void {
    const decision = this.decide(tx);
    if (decision === "wait") {
      tx.status = "PENDING_REFERENCE";
      return;
    }
    if ("reject" in decision) {
      tx.status = "REJECTED";
      tx.code = decision.reject;
      return;
    }
    this.balance[tx.wallet] = (this.balance[tx.wallet] as bigint) + decision.delta;
    tx.status = "PROCESSED";
    tx.code = undefined;
    // Only a PROCESSED reversal uses its reference up (FR-27).
    if (decision.reference && isReversal(tx.kind)) decision.reference.reversedBy = tx.name;
  }

  /** The rules, in the order the table gives them. Changes nothing. */
  private decide(tx: MTx): "wait" | { reject: string } | { delta: bigint; reference: MTx | undefined } {
    let reference: MTx | undefined;
    if (tx.ref !== undefined) {
      reference = this.txs.get(tx.ref);
      if (!reference) return "wait";
      if (reference.wallet !== tx.wallet || reference.round !== tx.round)
        return { reject: "REFERENCE_MISMATCH" };
      if (!ACCEPTS[tx.kind]?.includes(reference.kind)) return { reject: "REFERENCE_KIND_NOT_ALLOWED" };
      if (reference.status === "PENDING_REFERENCE") return "wait";
      if (reference.status !== "PROCESSED") return { reject: "REFERENCE_NOT_PROCESSED" };
      if (isReversal(tx.kind) && tx.cents !== reference.cents) return { reject: "REFERENCE_AMOUNT_MISMATCH" };
      if ((isReversal(tx.kind) || tx.kind === Kind.Win) && reference.reversedBy)
        return { reject: "ALREADY_REVERSED" };
    }

    let delta = 0n;
    if (tx.kind === Kind.Bet) delta = -tx.cents;
    else if (tx.kind === Kind.Win || tx.kind === Kind.Refund) delta = tx.cents;
    else if (tx.kind === Kind.Rollback) delta = reference?.kind === Kind.Bet ? tx.cents : -tx.cents;
    if (delta < 0n && (this.balance[tx.wallet] as bigint) + delta < 0n) {
      return { reject: tx.kind === Kind.Bet ? "INSUFFICIENT_FUNDS" : "REVERSAL_INSUFFICIENT_FUNDS" };
    }
    return { delta, reference };
  }
}

/** mulberry32: small, seedable, the same on every machine. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p: number) => next() < p,
  };
}

const AMOUNTS = [1_000n, 2_000n, 4_000n, 8_000n];
const KINDS = [Kind.Bet, Kind.Bet, Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback, Kind.Rollback];
const money = (cents: bigint) => ({
  amount: `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`,
});

/** What the sequences actually reached, so a generator that never gets to a rule cannot pass for having tested it. */
const reached = new Map<string, number>();
const reach = (what: string) => reached.set(what, (reached.get(what) ?? 0) + 1);

let world: SettlementWorld;
beforeAll(async () => {
  world = await SettlementWorld.create();
});
afterAll(async () => {
  await world.destroy();
});

function workerOverOneAtATime() {
  return new SettleWaitingReferences(
    new MikroOrmPendingReferenceStore(world.orm, world.options),
    world.unitOfWork,
    world.clock,
    world.ids,
    // One row per pass: the claim orders by schedule then age, so a sweep visits the waiting in the order they
    // arrived, which is the order the model uses. A bigger batch would settle its rows in no stated order.
    { batchSize: 1, leaseMs: 1_000, ttlMs: 3_600_000, retryDelayMs: () => 60_000 },
  );
}

async function runSequence(seed: number, steps: number): Promise<void> {
  const rng = random(seed);
  // One database serves every seed and an idempotency key is global, so each seed names its own transactions.
  const prefix = `s${seed}-`;
  const wallets = [
    await world.openWallet("100.00"),
    await world.openWallet("100.00"),
    await world.openWallet("100.00"),
  ];
  const walletIds = wallets.map((w) => w.walletId);
  const model = new Model(wallets.length, 10_000n);
  const worker = workerOverOneAtATime();
  const sent: Spec[] = [];
  const forced = new Map<Name, { wallet: number; cents: bigint; round: string }>();
  const log: string[] = [];
  let counter = 0;

  const submit = async (spec: Spec, as: { cents?: bigint } = {}) => {
    const cents = as.cents ?? spec.cents;
    return world.useCase.execute(
      command(wallets[spec.wallet] as { walletId: string; playerId: string }, {
        externalTransactionId: spec.name,
        idempotencyKey: `provider-a:${spec.name}`,
        kind: spec.kind,
        money: brl(money(cents).amount),
        roundId: spec.round,
        ...(spec.ref !== undefined ? { referenceExternalTransactionId: spec.ref } : {}),
      }),
    );
  };

  const sweepAll = async () => {
    // Until a whole sweep changes nothing: a settled row can release one that waited on it.
    for (let sweep = 0; sweep < 20; sweep += 1) {
      await world.sql(
        "update wager_transactions set next_retry_at = now() - interval '1 second' where status = 'PENDING_REFERENCE' and wallet_id = any(?::uuid[])",
        [`{${walletIds.join(",")}}`],
      );
      let touched = 0;
      for (let pass = 0; pass < 200; pass += 1) {
        const result = await worker.runOnce();
        if (result.claimed === 0) break;
        touched += result.settled + result.rejected;
      }
      const before = new Map(model.all().map((tx) => [tx.name, tx.status]));
      const changed = model.sweep();
      for (const tx of model.all()) {
        if (before.get(tx.name) === "PENDING_REFERENCE" && tx.status !== "PENDING_REFERENCE") {
          reach(`waited, then ${tx.status}${tx.code ? ` ${tx.code}` : ""}`);
        }
      }
      expect(touched > 0).toBe(changed);
      if (!changed) return;
    }
    throw new Error("the worker did not settle after 20 sweeps");
  };

  const expectState = async (where: string) => {
    for (const [i, wallet] of wallets.entries()) {
      const stored = (await world.walletState(wallet.walletId)).balance;
      expect(stored, `${where}: wallet ${i} balance`).toBe(
        `${(model.balance[i] as bigint) / 100n}.${((model.balance[i] as bigint) % 100n).toString().padStart(2, "0")}`,
      );
    }
  };

  for (let step = 0; step < steps; step += 1) {
    const roll = rng.next();
    try {
      if (roll < 0.1 && sent.length > 0) {
        // A duplicate, resent exactly or, now and then, under the same key with another amount.
        const spec = rng.pick(sent);
        const original = model.known(spec.name) as Spec & Outcome;
        if (rng.chance(0.25)) {
          reach("conflict on a resent key");
          log.push(`${step}: resend ${spec.name} with another amount`);
          await expect(submit(spec, { cents: spec.cents + 100n })).rejects.toBeInstanceOf(
            IdempotencyConflictError,
          );
        } else {
          reach(`replay of ${original.status}`);
          log.push(`${step}: resend ${spec.name}`);
          const result = await submit(spec);
          expect(result.idempotentReplay).toBe(true);
          expect(result.status as string).toBe(original.status);
          expect(result.failureCode as string | undefined).toBe(original.code);
        }
      } else if (roll < 0.2) {
        log.push(`${step}: worker`);
        await sweepAll();
      } else {
        counter += 1;
        const name = `${prefix}t${counter}`;
        const plan = forced.get(name);
        forced.delete(name);
        let spec: Spec;
        if (plan) {
          // The thing an early reversal was waiting for.
          spec = { name, wallet: plan.wallet, kind: Kind.Bet, cents: plan.cents, round: plan.round };
        } else {
          const kind = rng.pick(KINDS);
          const wallet = rng.int(wallets.length);
          const cents = rng.pick(AMOUNTS);
          const round = rng.chance(0.05) ? "other-round" : `round-${wallet}`;
          spec = { name, wallet, kind, cents, round };
          if (ACCEPTS[kind]) {
            const optional = kind === Kind.Win || kind === Kind.Loss;
            if (!optional || rng.chance(0.6)) {
              const compatible = sent.filter((x) => x.wallet === wallet && ACCEPTS[kind]?.includes(x.kind));
              if (compatible.length > 0 && rng.chance(0.75)) {
                // Mostly a transaction it may legitimately point at, so the rules that come after the first
                // checks (already reversed, amount, funds) are reached; the rest of the time anything.
                const target = rng.pick(compatible);
                spec.ref = target.name;
                spec.round = target.round;
                spec.cents = rng.chance(0.85) ? target.cents : rng.pick(AMOUNTS);
              } else if (rng.chance(0.2)) {
                // Before its reference exists: the reference will be a BET created a few steps from now.
                const future = `${prefix}t${counter + 1 + rng.int(3)}`;
                spec.ref = future;
                if (!forced.has(future) && !model.known(future)) {
                  forced.set(future, { wallet, cents: rng.chance(0.75) ? cents : rng.pick(AMOUNTS), round });
                }
              } else if (counter > 1) {
                spec.ref = `${prefix}t${1 + rng.int(counter - 1)}`;
              } else {
                spec.ref = "nothing-by-this-name";
              }
            }
          }
          if (isReversal(kind) && spec.ref === undefined) spec.ref = "nothing-by-this-name";
        }
        log.push(
          `${step}: ${spec.kind} ${spec.name} w${spec.wallet} ${spec.cents} ${spec.ref ? `ref ${spec.ref}` : ""}`,
        );
        sent.push(spec);
        const expected = model.submit(spec);
        reach(`${spec.kind} ${expected.status}${expected.code ? ` ${expected.code}` : ""}`);
        const result = await submit(spec);
        expect(result.idempotentReplay).toBe(false);
        expect(result.status as string).toBe(expected.status);
        expect(result.failureCode as string | undefined).toBe(expected.code);
      }
      await expectState(`step ${step}`);
    } catch (error) {
      throw new Error(
        `seed ${seed}, step ${step}: ${error instanceof Error ? error.message : String(error)}\n` +
          `repeat with: MODEL_SEED=${seed} bun test test/integration/settlement-model.test.ts\n` +
          `steps so far:\n  ${log.join("\n  ")}`,
        { cause: error },
      );
    }
  }

  try {
    await sweepAll();
    await expectState("the end");
    // What the model says each transaction ended as, against what is stored.
    for (const tx of model.all()) {
      const [row] = await world.sql(
        "select status, failure_code from wager_transactions where external_transaction_id = ? and wallet_id = ?",
        [tx.name, walletIds[tx.wallet]],
      );
      expect(row?.status, `${tx.name} (${tx.kind})`).toBe(tx.status);
      expect(row?.failure_code ?? undefined, `${tx.name} failure code`).toBe(tx.code);
    }
    for (const wallet of wallets) await world.expectLedgerExplainsBalance(wallet.walletId);
  } catch (error) {
    throw new Error(
      `seed ${seed}, at the end: ${error instanceof Error ? error.message : String(error)}\n` +
        `repeat with: MODEL_SEED=${seed} bun test test/integration/settlement-model.test.ts\n` +
        `steps:\n  ${log.join("\n  ")}`,
      { cause: error },
    );
  }
}

describe("random sequences against a reference model (issue #54)", () => {
  const single = process.env.MODEL_SEED;
  const seeds = single
    ? [Number(single)]
    : Array.from({ length: Number(process.env.MODEL_RUNS ?? 20) }, (_, i) => i + 1);
  test.each(seeds)("seed %d: every answer, every balance, and balance == ledger", async (seed) => {
    await runSequence(seed, 60);
  });
});

describe("the generator reaches the rules it is meant to test", () => {
  // Only meaningful for the default run: a single seed or a short one does not have to reach everything.
  const full = !process.env.MODEL_SEED && Number(process.env.MODEL_RUNS ?? 20) >= 20;
  test.skipIf(!full)("every outcome the model can produce was produced", () => {
    const required = [
      "BET PROCESSED",
      "BET REJECTED INSUFFICIENT_FUNDS",
      "WIN PROCESSED",
      "LOSS PROCESSED",
      "REFUND PROCESSED",
      "REFUND REJECTED REFERENCE_AMOUNT_MISMATCH",
      "REFUND REJECTED ALREADY_REVERSED",
      "REFUND PENDING_REFERENCE",
      "ROLLBACK PROCESSED",
      "ROLLBACK REJECTED REFERENCE_KIND_NOT_ALLOWED",
      "ROLLBACK REJECTED REVERSAL_INSUFFICIENT_FUNDS",
      "ROLLBACK REJECTED ALREADY_REVERSED",
      "WIN REJECTED ALREADY_REVERSED",
      "REFUND REJECTED REFERENCE_MISMATCH",
      "waited, then PROCESSED",
      "waited, then REJECTED ALREADY_REVERSED",
      "replay of PROCESSED",
      "replay of REJECTED",
      "replay of PENDING_REFERENCE",
      "conflict on a resent key",
    ];
    const missing = required.filter((what) => (reached.get(what) ?? 0) === 0);
    expect(missing, `never reached; the counts were ${JSON.stringify([...reached])}`).toEqual([]);
  });
});
