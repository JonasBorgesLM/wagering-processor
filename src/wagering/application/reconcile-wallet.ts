import { TransientFailureError, WalletNotFoundError } from "./errors";
import type { DivergenceReporter, ReconciliationReader, ReconciliationReport } from "./ports";

/**
 * Compares a wallet's stored balance with what its ledger adds up to, and checks that the entries chain (FR-70).
 *
 * It reads and reports and never writes: a divergence is a fact for a person to look into, because correcting it
 * would be deciding which of the two numbers is the lie (FR-72). The check is also not a guard on settlement, which
 * is why it takes no lock and cannot slow a busy wallet down (FR-71).
 *
 * It does read the whole ledger, and the endpoint has no caller identity, so how many run at once in this process is
 * bounded (FR-102, T-16): one over the bound is refused as transient at once, rather than queued behind the others,
 * which would only move the pooled connections it holds from the database to the waiting. The bound is per process,
 * not global: with N processes the database sees up to N times as many.
 */
export class ReconcileWallet {
  constructor(
    private readonly reader: ReconciliationReader,
    private readonly reporter: DivergenceReporter,
    private readonly maxConcurrent = Number.POSITIVE_INFINITY,
  ) {}

  private running = 0;

  async execute(walletId: string): Promise<ReconciliationReport> {
    if (this.running >= this.maxConcurrent) {
      throw new TransientFailureError(
        `${this.running} reconciliations are already running; try again shortly`,
      );
    }
    this.running += 1;
    try {
      return await this.reconcile(walletId);
    } finally {
      this.running -= 1;
    }
  }

  private async reconcile(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.reader.snapshot(walletId);
    if (!snapshot) throw new WalletNotFoundError(`wallet ${walletId} does not exist`);

    const calculatedBalance = snapshot.credits.subtract(snapshot.debits);
    const difference = snapshot.storedBalance.subtract(calculatedBalance);
    const report: ReconciliationReport = {
      walletId,
      storedBalance: snapshot.storedBalance,
      calculatedBalance,
      difference,
      // The balance can add up while the entries do not, so both have to hold.
      consistent: difference.isZero() && snapshot.issueCount === 0,
      checkedEntries: snapshot.checkedEntries,
      issueCount: snapshot.issueCount,
      issues: snapshot.issues,
    };
    this.reporter.checked(report);
    return report;
  }
}
