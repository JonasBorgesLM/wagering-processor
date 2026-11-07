import type { MikroORM } from "@mikro-orm/postgresql";
import type { PendingReferenceStore, WaitingTransaction } from "../../application/ports";
import { boundedTransaction, type UnitOfWorkOptions } from "./mikro-orm-unit-of-work";

interface ClaimedRow {
  id: string;
  wallet_id: string;
  retry_attempts: number;
}

export class MikroOrmPendingReferenceStore implements PendingReferenceStore {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
  ) {}

  async claimDue(limit: number, leaseMs: number, now: Date): Promise<WaitingTransaction[]> {
    // The same claim as the outbox's, for the same reasons: one statement, SKIP LOCKED, the lease in the schedule.
    const rows = await boundedTransaction(
      this.orm,
      this.options,
      async (em) =>
        (await em.getConnection().execute(
          `update wager_transactions t
            set next_retry_at = ?, retry_attempts = t.retry_attempts + 1
           from (select id from wager_transactions
                  where status = 'PENDING_REFERENCE' and next_retry_at <= ?
                  order by next_retry_at, created_at, id
                  limit ?
                    for update skip locked) due
          where t.id = due.id
      returning t.id, t.wallet_id, t.retry_attempts, t.created_at`,
          [new Date(now.getTime() + leaseMs), now, limit],
          "all",
          em.getTransactionContext(),
        )) as Array<ClaimedRow & { created_at: Date | string }>,
    );
    // Oldest first: a reversal that waits on another reversal is always the younger of the two, so the older one
    // settles first in the same round and the younger finds it processed.
    return rows
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id.localeCompare(b.id),
      )
      .map((row) => ({ id: row.id, walletId: row.wallet_id, attempts: row.retry_attempts }));
  }
}
