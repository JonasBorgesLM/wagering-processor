import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import type {
  DeadLetterReason,
  DuplicateKind,
  RetryComponent,
  TransientReason,
  WageringMetrics,
} from "../../application/ports";

/**
 * The metrics of NFR-06, on the registry that `/metrics` serves. The counters that an alert would watch (duplicates,
 * retries, dead letters, lock conflicts) start with every label at zero, so a rate over one that has not happened yet
 * is 0 and not absent: an alert on "dead letters increasing" must not depend on one having happened first.
 */
export class PrometheusMetrics implements WageringMetrics {
  private readonly transactions: Counter<"status" | "kind" | "source">;
  private readonly duplicates: Counter<"kind">;
  private readonly retries: Counter<"component">;
  private readonly deadLetters: Counter<"reason">;
  private readonly lockConflicts: Counter<"kind">;
  private readonly transientFailures: Counter<"reason">;
  private readonly duration: Histogram<"source" | "outcome">;

  constructor(registry: Registry) {
    const registers = [registry];
    this.transactions = new Counter({
      name: "wagering_transactions_total",
      help: "Transactions by the status a decision gave them. Replays are not counted.",
      labelNames: ["status", "kind", "source"],
      registers,
    });
    this.duplicates = new Counter({
      name: "wagering_duplicates_total",
      help: "Duplicates detected: a replay answered from the stored result, or a conflict refused.",
      labelNames: ["kind"],
      registers,
    });
    this.retries = new Counter({
      name: "wagering_retries_total",
      help: "Work put back to be tried again, by the component that did it.",
      labelNames: ["component"],
      registers,
    });
    this.deadLetters = new Counter({
      name: "wagering_dlq_messages_total",
      help: "Messages moved to the dead-letter queue, by why.",
      labelNames: ["reason"],
      registers,
    });
    this.lockConflicts = new Counter({
      name: "wagering_lock_conflicts_total",
      help: "Waits for a wallet lock that ended in a lock timeout or a deadlock.",
      labelNames: ["kind"],
      registers,
    });
    this.transientFailures = new Counter({
      name: "wagering_database_transient_failures_total",
      help: "Database calls that failed in a way trying again may fix, by reason. Includes the lock conflicts.",
      labelNames: ["reason"],
      registers,
    });
    this.duration = new Histogram({
      name: "wagering_settlement_duration_seconds",
      help: "How long one settlement took, by where it came from and how it ended.",
      labelNames: ["source", "outcome"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    });

    // The transactions series are not created ahead: status, kind and source combine into dozens of series, most of
    // which cannot happen. An alert on them is on a rate that exists once the first one does.
    for (const kind of [
      "replay",
      "idempotency_conflict",
      "external_id_conflict",
      "message_id_conflict",
    ] as const) {
      this.duplicates.inc({ kind }, 0);
    }
    for (const component of ["consumer", "outbox", "reference_worker", "duplicate_race"] as const) {
      this.retries.inc({ component }, 0);
    }
    for (const reason of ["permanent", "attempts-exhausted"] as const) this.deadLetters.inc({ reason }, 0);
    for (const kind of ["lock_timeout", "deadlock"] as const) this.lockConflicts.inc({ kind }, 0);
    for (const reason of [
      "lock_timeout",
      "deadlock",
      "serialization_failure",
      "statement_timeout",
      "pool_timeout",
      "connection",
      "other",
    ] as const) {
      this.transientFailures.inc({ reason }, 0);
    }
  }

  transactionDecided(event: { status: string; kind: string; source: string }): void {
    this.transactions.inc(event);
  }
  duplicateDetected(kind: DuplicateKind): void {
    this.duplicates.inc({ kind });
  }
  retried(component: RetryComponent): void {
    this.retries.inc({ component });
  }
  deadLettered(reason: DeadLetterReason): void {
    this.deadLetters.inc({ reason });
  }
  databaseTransient(reason: TransientReason): void {
    this.transientFailures.inc({ reason });
    if (reason === "lock_timeout" || reason === "deadlock") this.lockConflicts.inc({ kind: reason });
  }
  settlementTimed(event: { source: string; outcome: string; seconds: number }): void {
    this.duration.observe({ source: event.source, outcome: event.outcome }, event.seconds);
  }
}

/**
 * How far behind publishing is, measured when Prometheus asks and not kept up to date by anyone: the age of the
 * oldest event not yet published, and how many are waiting. Computed from the table, so it is true of the whole
 * system whichever process answers the scrape, and a publisher that is down shows as a lag that grows.
 *
 * A failure to measure leaves the last value rather than inventing a zero, which would read as "all caught up".
 */
export function registerOutboxGauges(
  registry: Registry,
  measure: () => Promise<{ unpublished: number; oldestAgeSeconds: number }>,
): void {
  new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Age of the oldest outbox event that has not been published. 0 when there is none.",
    registers: [registry],
    async collect() {
      try {
        this.set((await measure()).oldestAgeSeconds);
      } catch {
        // Keep the previous value.
      }
    },
  });
  new Gauge({
    name: "wagering_outbox_unpublished",
    help: "Outbox events not yet published.",
    registers: [registry],
    async collect() {
      try {
        this.set((await measure()).unpublished);
      } catch {
        // Keep the previous value.
      }
    },
  });
}
