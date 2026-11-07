import { Logger } from "@nestjs/common";
import { Counter, type Registry } from "prom-client";
import type { DivergenceReporter, ReconciliationReport } from "../../application/ports";

/**
 * Makes a divergence visible in the two places an operator looks (FR-72): the log, as an error with the wallet,
 * and a counter to alert on. The counter has no wallet label on purpose: one series per wallet is unbounded, and
 * the log names the wallet.
 */
export class PrometheusDivergenceReporter implements DivergenceReporter {
  private readonly logger = new Logger("Reconciliation");
  private readonly reconciliations: Counter<"result">;

  constructor(registry: Registry) {
    this.reconciliations = new Counter({
      name: "wagering_reconciliations_total",
      help: "Wallet reconciliations by result. A rate of divergent above zero is a financial incident.",
      labelNames: ["result"],
      registers: [registry],
    });
    // Both series exist from the start, so a rate over "divergent" is 0 and not absent.
    this.reconciliations.inc({ result: "consistent" }, 0);
    this.reconciliations.inc({ result: "divergent" }, 0);
  }

  checked(report: ReconciliationReport): void {
    this.reconciliations.inc({ result: report.consistent ? "consistent" : "divergent" });
    if (report.consistent) return;
    const issues = report.issues.map((issue) => `${issue.kind}@${issue.walletVersion}`).join(", ");
    this.logger.error(
      `Wallet diverges from its ledger: stored ${report.storedBalance.toString()}, ledger ${report.calculatedBalance.toString()}, ` +
        `difference ${report.difference.toString()}, ${report.issueCount} entr${report.issueCount === 1 ? "y" : "ies"} with a problem` +
        (issues ? ` (${issues})` : ""),
      { walletId: report.walletId },
    );
  }
}
