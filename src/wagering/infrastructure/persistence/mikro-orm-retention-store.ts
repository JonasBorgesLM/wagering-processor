import type { MikroORM } from "@mikro-orm/postgresql";
import type { RetentionStore } from "../../application/ports";
import { boundedTransaction, type UnitOfWorkOptions } from "./mikro-orm-unit-of-work";

export class MikroOrmRetentionStore implements RetentionStore {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
  ) {}

  deleteInboxReceivedBefore(cutoff: Date, limit: number): Promise<number> {
    // The primary key is two columns, and `ctid` names the row without needing both. SKIP LOCKED lets two processes
    // running this at once take different rows instead of waiting on each other.
    return this.deleteBatch(
      `delete from inbox_messages
        where ctid in (select ctid from inbox_messages where received_at < ? limit ? for update skip locked)`,
      [cutoff, limit],
    );
  }

  deletePublishedOutboxBefore(cutoff: Date, limit: number): Promise<number> {
    // `published_at is not null` is the safety: an unpublished event is a promise not yet kept, whatever its age.
    return this.deleteBatch(
      `delete from outbox_messages
        where id in (select id from outbox_messages where published_at is not null and published_at < ? limit ? for update skip locked)`,
      [cutoff, limit],
    );
  }

  private async deleteBatch(sql: string, params: unknown[]): Promise<number> {
    return boundedTransaction(this.orm, this.options, async (em) => {
      const result = (await em.getConnection().execute(sql, params, "run", em.getTransactionContext())) as {
        affectedRows?: number;
        rowCount?: number;
      };
      return result.affectedRows ?? result.rowCount ?? 0;
    });
  }
}
