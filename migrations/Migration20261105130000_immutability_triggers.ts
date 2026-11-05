import { Migration } from "@mikro-orm/migrations";

/**
 * The audit trail cannot be rewritten by the application (§5.5, §6.4), and a
 * settled transaction does not change (§6.3). These raise `restrict_violation`,
 * so they read as integrity failures and not as bugs in a function.
 *
 * Statement level on the ledger on purpose: a row trigger does not fire on
 * TRUNCATE, which would otherwise empty the ledger without a word.
 *
 * Not covered: the table's owner or a superuser can disable a trigger. See T-09.
 */
export class Migration20261105130000_immutability_triggers extends Migration {
  override up(): void {
    this.addSql(`
      create function refuse_ledger_change() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % refused', tg_op using errcode = 'restrict_violation';
      end;
      $$
    `);
    this.addSql(`
      create trigger tr_ledger_append_only before update or delete or truncate on wallet_ledger_entries
      for each statement execute function refuse_ledger_change()
    `);

    this.addSql(`
      create function refuse_terminal_transaction_change() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is % and terminal: % refused', old.id, old.status, tg_op using errcode = 'restrict_violation';
        end if;
        return coalesce(new, old);
      end;
      $$
    `);
    this.addSql(`
      create trigger tr_wager_transactions_terminal before update or delete on wager_transactions
      for each row execute function refuse_terminal_transaction_change()
    `);
  }

  override down(): void {
    this.addSql("drop trigger tr_wager_transactions_terminal on wager_transactions");
    this.addSql("drop function refuse_terminal_transaction_change()");
    this.addSql("drop trigger tr_ledger_append_only on wallet_ledger_entries");
    this.addSql("drop function refuse_ledger_change()");
  }
}
