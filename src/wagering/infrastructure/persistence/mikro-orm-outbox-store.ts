import type { MikroORM } from "@mikro-orm/postgresql";
import type { OutboxEntry, OutboxStore } from "../../application/ports";
import { boundedTransaction, type UnitOfWorkOptions } from "./mikro-orm-unit-of-work";

interface ClaimedRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: object;
  attempts: number;
  occurred_at: Date | string;
}

export class MikroOrmOutboxStore implements OutboxStore {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
  ) {}

  async claimDue(limit: number, leaseMs: number, now: Date): Promise<OutboxEntry[]> {
    // One statement, so selecting and leasing cannot be separated. SKIP LOCKED makes a publisher pass over rows
    // another one is claiming at this very moment instead of waiting for them, so two never take the same row.
    const rows = await boundedTransaction(
      this.orm,
      this.options,
      async (em) =>
        (await em.getConnection().execute(
          `update outbox_messages o
            set next_attempt_at = ?, attempts = o.attempts + 1
           from (select id from outbox_messages
                  where published_at is null and next_attempt_at <= ?
                  order by next_attempt_at, occurred_at, id
                  limit ?
                    for update skip locked) due
          where o.id = due.id
      returning o.id, o.event_type, o.aggregate_id, o.payload, o.attempts, o.occurred_at`,
          [new Date(now.getTime() + leaseMs), now, limit],
          "all",
          em.getTransactionContext(),
        )) as ClaimedRow[],
    );
    // The statement does not promise an order, and a wallet's events should leave in the order they happened.
    return rows
      .sort(
        (a, b) =>
          new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime() || a.id.localeCompare(b.id),
      )
      .map((row) => ({
        id: row.id,
        eventType: row.event_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        attempts: row.attempts,
      }));
  }

  async markPublished(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    // Only while unpublished: if the lease ran out and another publisher got there first, this changes nothing.
    await boundedTransaction(this.orm, this.options, (em) =>
      em
        .getConnection()
        .execute(
          "update outbox_messages set published_at = ? where id = any(?::uuid[]) and published_at is null",
          [at, `{${ids.join(",")}}`],
          "run",
          em.getTransactionContext(),
        ),
    );
  }

  async reschedule(items: ReadonlyArray<{ id: string; nextAttemptAt: Date }>): Promise<void> {
    if (items.length === 0) return;
    // Each row at its own time, in one statement; a row published in the meantime is left alone.
    await boundedTransaction(this.orm, this.options, (em) =>
      em.getConnection().execute(
        `update outbox_messages o set next_attempt_at = t.at
             from unnest(?::uuid[], ?::timestamptz[]) as t(id, at)
            where o.id = t.id and o.published_at is null`,
        [
          `{${items.map((item) => item.id).join(",")}}`,
          `{${items.map((item) => `"${item.nextAttemptAt.toISOString()}"`).join(",")}}`,
        ],
        "run",
        em.getTransactionContext(),
      ),
    );
  }
}
