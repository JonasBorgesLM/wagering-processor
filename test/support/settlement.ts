import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../src/platform/database/mikro-orm.config";
import { OpenWallet } from "../../src/wagering/application/open-wallet";
import type { TransactionContext, UnitOfWork } from "../../src/wagering/application/ports";
import { QueryWallets } from "../../src/wagering/application/query-wallets";
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from "../../src/wagering/application/submit-wager-transaction";
import { Money } from "../../src/wagering/domain/money";
import { WagerTransactionKind as Kind, WagerTransaction } from "../../src/wagering/domain/wager-transaction";
import { Wallet } from "../../src/wagering/domain/wallet";
import { MikroOrmUnitOfWork } from "../../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work";
import { MikroOrmWalletReader } from "../../src/wagering/infrastructure/persistence/mikro-orm-wallet-reader";
import { wageringEntitySchemas } from "../../src/wagering/infrastructure/persistence/schemas";
import { SystemClock, UuidV7Generator } from "../../src/wagering/infrastructure/system";
import { createTestDatabase, type TestDatabase } from "./database";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

export function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A real database, migrated, with the real unit of work and use case. */
export class SettlementWorld {
  readonly clock = new SystemClock();
  readonly ids = new UuidV7Generator();
  readonly unitOfWork: UnitOfWork;
  readonly useCase: SubmitWagerTransaction;
  readonly wallets: OpenWallet;
  readonly queries: QueryWallets;

  private constructor(
    readonly orm: MikroORM,
    private readonly database: TestDatabase,
    readonly options: { lockTimeoutMs: number; statementTimeoutMs: number },
  ) {
    this.unitOfWork = new MikroOrmUnitOfWork(orm, this.clock, options);
    this.useCase = new SubmitWagerTransaction(this.unitOfWork, this.clock, this.ids);
    this.wallets = new OpenWallet(this.unitOfWork, this.clock, this.ids);
    this.queries = new QueryWallets(new MikroOrmWalletReader(orm, options));
  }

  databaseUrl(): string {
    return this.database.url;
  }

  static async create(
    options = { lockTimeoutMs: 2_000, statementTimeoutMs: 5_000 },
    pool: { max?: number; acquireTimeoutMs?: number } = {},
  ) {
    const database = await createTestDatabase();
    const orm = await MikroORM.init(createOrmConfig(database.url, "migrations", wageringEntitySchemas, pool));
    await orm.migrator.up();
    return new SettlementWorld(orm, database, options);
  }

  async destroy() {
    await this.orm.close();
    await this.database.drop();
  }

  useCaseWith(unitOfWork: UnitOfWork) {
    return new SubmitWagerTransaction(unitOfWork, this.clock, this.ids);
  }

  sql(query: string, params: unknown[] = []) {
    return this.orm.em.getConnection().execute(query, params);
  }

  /** A wallet with its OPENING and entry, so the ledger explains the balance from the start. */
  async openWallet(
    balance: string,
    playerId: string = randomUUID(),
  ): Promise<{ walletId: string; playerId: string }> {
    const now = this.clock.now();
    const id = randomUUID();
    const opening = { transactionId: randomUUID(), entryId: randomUUID() };
    const initialBalance = brl(balance);
    const { wallet, openingEntry } = Wallet.open({
      id,
      playerId,
      initialBalance,
      at: now,
      ...(initialBalance.isZero() ? {} : { opening }),
    });
    await this.unitOfWork.run(async (tx) => {
      await tx.wallets.insert(wallet);
      if (openingEntry) {
        const transaction = WagerTransaction.createOpening({
          id: opening.transactionId,
          walletId: id,
          playerId,
          money: initialBalance,
          createdAt: now,
        });
        transaction.markProcessed(undefined, initialBalance, now);
        await tx.transactions.insert(transaction);
        await tx.ledger.append(openingEntry);
      }
    });
    return { walletId: id, playerId };
  }

  /** Takes the wallet's row lock in a transaction of its own and keeps it until the returned function is called. */
  async holdLock(walletId: string): Promise<() => Promise<void>> {
    const held = deferred();
    const release = deferred();
    const holder = this.unitOfWork.run(async (tx) => {
      await tx.wallets.lockById(walletId);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    return async () => {
      release.resolve();
      await holder;
    };
  }

  async walletState(walletId: string) {
    const rows = await this.sql("select balance, version from wallets where id = ?", [walletId]);
    return { balance: rows[0]?.balance as string, version: rows[0]?.version as number };
  }

  async counts(walletId: string) {
    const rows = await this.sql(
      `select
         (select count(*)::int from wager_transactions where wallet_id = ? and kind <> 'OPENING') as transactions,
         (select count(*)::int from wallet_ledger_entries e join wager_transactions t on t.id = e.transaction_id where e.wallet_id = ? and t.kind <> 'OPENING') as entries,
         (select count(*)::int from outbox_messages where aggregate_id = ?) as events`,
      [walletId, walletId, walletId],
    );
    return rows[0] as { transactions: number; entries: number; events: number };
  }

  /** The invariant every test ends on (§13): the stored balance is what the ledger rebuilds, link by link. */
  async expectLedgerExplainsBalance(walletId: string) {
    const entries = await this.sql(
      "select direction, amount::text as amount, balance_before::text as before, balance_after::text as after from wallet_ledger_entries where wallet_id = ? order by wallet_version",
      [walletId],
    );
    let rebuilt = Money.zero("BRL");
    for (const entry of entries) {
      expect(entry.before).toBe(rebuilt.toJSON().amount);
      rebuilt =
        entry.direction === "CREDIT" ? rebuilt.add(brl(entry.amount)) : rebuilt.subtract(brl(entry.amount));
      expect(entry.after).toBe(rebuilt.toJSON().amount);
    }
    expect((await this.walletState(walletId)).balance).toBe(rebuilt.toJSON().amount);
  }
}

export function command(
  wallet: { walletId: string; playerId: string },
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const external = overrides.externalTransactionId ?? randomUUID();
  return {
    idempotencyKey: `provider-a:${external}`,
    providerId: "provider-a",
    externalTransactionId: external,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: brl("80.00"),
    correlationId: randomUUID(),
    ...overrides,
  };
}

/** Wraps a unit of work so a test can see or interrupt each repository call on the real transaction. */
export function instrumented(
  inner: UnitOfWork,
  hook: (call: string, phase: "before" | "after") => void | Promise<void>,
): UnitOfWork {
  const wrap = <T extends object>(name: string, target: T): T =>
    new Proxy(target, {
      get(object, property) {
        const member = Reflect.get(object, property);
        if (typeof member !== "function") return member;
        return async (...args: unknown[]) => {
          const call = `${name}.${String(property)}`;
          await hook(call, "before");
          const result = await member.apply(object, args);
          await hook(call, "after");
          return result;
        };
      },
    });
  return {
    run: (work) =>
      inner.run((tx: TransactionContext) =>
        work({
          wallets: wrap("wallets", tx.wallets),
          transactions: wrap("transactions", tx.transactions),
          ledger: wrap("ledger", tx.ledger),
          outbox: wrap("outbox", tx.outbox),
        }),
      ),
  };
}
