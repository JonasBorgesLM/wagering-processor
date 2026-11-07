import type { MikroORM } from "@mikro-orm/postgresql";
import type { LedgerIssue, LedgerSnapshot, ReconciliationReader } from "../../application/ports";
import { Money } from "../../domain/money";
import { boundedTransaction, type UnitOfWorkOptions } from "./mikro-orm-unit-of-work";

/** How many problem entries are named in the answer. The count is always whole. */
export const ISSUES_SHOWN = 20;

interface Row {
  stored: string;
  currency: string;
  checked: number;
  credits: string;
  debits: string;
  issue_count: number;
  issues: LedgerIssue[];
}

/**
 * One statement, so the wallet and every entry come from the same snapshot (FR-71): a settlement committing
 * halfway through would otherwise show a balance the ledger has not caught up with, and report a divergence that
 * is only a race. Takes no lock. The work is a range scan over `uq_ledger_wallet_version` and grows with the
 * wallet's ledger, which is bounded by the statement timeout (NFR-11).
 *
 * What it checks, per entry: that it adds up (`balanceBefore` ± amount = `balanceAfter`), that it is in the
 * wallet's currency, and that it continues the entry before (`balanceBefore` = the previous `balanceAfter`, and 0
 * for the first). Anything else the ledger could be wrong about the stored balance catches by the sum.
 */
const SQL = `
with wallet as (select balance, currency from wallets where id = ?),
entries as (
  select wallet_version, direction, amount, currency, balance_before, balance_after,
         lag(balance_after) over (order by wallet_version) as previous_after
    from wallet_ledger_entries
   where wallet_id = ?
),
checked as (
  select wallet_version,
         case
           when currency <> (select currency from wallet) then 'CURRENCY_MISMATCH'
           when balance_before + case when direction = 'CREDIT' then amount else -amount end <> balance_after
             then 'ENTRY_UNBALANCED'
           when balance_before <> coalesce(previous_after, 0) then 'CHAIN_BROKEN'
         end as kind
    from entries
)
select w.balance::text as stored, w.currency,
       (select count(*)::int from entries) as checked,
       (select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::numeric(20,2)::text from entries) as credits,
       (select coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::numeric(20,2)::text from entries) as debits,
       (select count(*)::int from checked where kind is not null) as issue_count,
       (select coalesce(json_agg(json_build_object('walletVersion', wallet_version, 'kind', kind)
                                 order by wallet_version), '[]'::json)
          from (select wallet_version, kind from checked where kind is not null
                 order by wallet_version limit ${ISSUES_SHOWN}) shown) as issues
  from wallet w
`;

export class MikroOrmReconciliationReader implements ReconciliationReader {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
  ) {}

  async snapshot(walletId: string): Promise<LedgerSnapshot | undefined> {
    const rows = await boundedTransaction(
      this.orm,
      this.options,
      async (em) =>
        (await em
          .getConnection()
          .execute(SQL, [walletId, walletId], "all", em.getTransactionContext())) as Row[],
    );
    const row = rows[0];
    if (!row) return undefined;
    const money = (amount: string) => Money.from({ amount, currency: row.currency });
    return {
      storedBalance: money(row.stored),
      credits: money(row.credits),
      debits: money(row.debits),
      checkedEntries: row.checked,
      issueCount: row.issue_count,
      issues: row.issues,
    };
  }
}
