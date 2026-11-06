import type { MikroORM } from "@mikro-orm/postgresql";
import { boundedTransaction, type UnitOfWorkOptions } from "./mikro-orm-unit-of-work";

/**
 * The table's own view of how far behind publishing is. A scan of the unpublished rows, which the partial index
 * `ix_outbox_due` covers, so it is as large as the backlog and no larger.
 */
export function measureOutbox(orm: MikroORM, options: UnitOfWorkOptions) {
  return async (): Promise<{ unpublished: number; oldestAgeSeconds: number }> => {
    const rows = await boundedTransaction(
      orm,
      options,
      async (em) =>
        (await em.getConnection().execute(
          `select count(*)::int as unpublished,
                    coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8 as age
               from outbox_messages where published_at is null`,
          [],
          "all",
          em.getTransactionContext(),
        )) as Array<{ unpublished: number; age: number }>,
    );
    return { unpublished: rows[0]?.unpublished ?? 0, oldestAgeSeconds: Math.max(0, rows[0]?.age ?? 0) };
  };
}
