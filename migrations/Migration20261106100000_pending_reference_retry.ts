import { Migration } from "@mikro-orm/migrations";

/**
 * The schedule of a transaction that is waiting for its reference (FR-40). It lives on the row, next to the
 * status it belongs to, and nowhere else: a waiting transaction is found by the database and not remembered by a
 * process, so any instance can take it up after a restart.
 *
 * The check keeps the schedule from outliving the wait. A settled or expired row carries none.
 */
export class Migration20261106100000_pending_reference_retry extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column retry_attempts integer not null default 0,
        add column next_retry_at timestamptz,
        add constraint ck_wager_transactions_retry_attempts_non_negative check (retry_attempts >= 0),
        add constraint ck_wager_transactions_retry_only_while_waiting check (status = 'PENDING_REFERENCE' or next_retry_at is null)
    `);
    this.addSql(
      "create index ix_wager_transactions_retry_due on wager_transactions (next_retry_at) where status = 'PENDING_REFERENCE'",
    );
  }

  override down(): void {
    this.addSql("drop index ix_wager_transactions_retry_due");
    this.addSql(`
      alter table wager_transactions
        drop constraint ck_wager_transactions_retry_only_while_waiting,
        drop constraint ck_wager_transactions_retry_attempts_non_negative,
        drop column next_retry_at,
        drop column retry_attempts
    `);
  }
}
