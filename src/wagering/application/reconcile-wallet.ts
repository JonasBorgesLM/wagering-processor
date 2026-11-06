import { WalletNotFoundError } from "./errors";
import type { DivergenceReporter, ReconciliationReader, ReconciliationReport } from "./ports";

/**
 * Compares a wallet's stored balance with what its ledger adds up to, and checks that the entries chain (FR-70).
 *
 * It reads and reports and never writes: a divergence is a fact for a person to look into, because correcting it
 * would be deciding which of the two numbers is the lie (FR-72). The check is also not a guard on settlement, which
 * is why it takes no lock and cannot slow a busy wallet down (FR-71).
 */
export class ReconcileWallet {
  constructor(
    private readonly reader: ReconciliationReader,
    private readonly reporter: DivergenceReporter,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
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
