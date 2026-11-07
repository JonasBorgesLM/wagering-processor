// The protections, each as one small edit that removes it (issue #55). `bun run test:mutation` applies them one at a
// time, runs the tests that guard each, and fails if any test run stays green: a protection nobody would miss.
//
// A mutant is an exact string in one file and what replaces it. The string must occur exactly once, so a refactor that
// moves or renames the protection fails the run as a stale mutant instead of silently testing nothing. Edits keep the
// file valid: a mutant that only breaks the build proves nothing, and the runner rejects a "kill" that is not a
// failed assertion.

export interface Mutant {
  id: string;
  /** What is removed, in words. */
  protection: string;
  /** The threat (THREAT-MODEL.md) or requirement it answers. */
  guards: string;
  file: string;
  find: string;
  replace: string;
  /** The test files that must go red. */
  tests: string[];
  /** Only the tests whose name matches, for a file that holds slow tests of other things. */
  filter?: string;
}

export const MUTANTS: Mutant[] = [
  {
    id: "wallet-lock",
    protection: "the wallet row lock",
    guards: "T-02, ADR-0003",
    file: "src/wagering/infrastructure/persistence/mikro-orm-unit-of-work.ts",
    find: "{ lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true }",
    replace: "{ disableIdentityMap: true }",
    tests: ["test/concurrency/settlement.test.ts"],
  },
  {
    id: "idempotency-lookup",
    protection: "the lookup of an operation already stored",
    guards: "T-01, T-12",
    file: "src/wagering/application/submit-wager-transaction.ts",
    find: "    if (!existing) return undefined;\n\n    if (existing.idempotencyKey",
    replace: "    return undefined;\n\n    if (existing.idempotencyKey",
    tests: ["test/integration/settlement.test.ts", "test/concurrency/settlement.test.ts"],
  },
  {
    id: "payload-hash-comparison",
    protection: "the comparison of the payload hash on a repeated key",
    guards: "T-12, FR idempotency conflict",
    file: "src/wagering/application/submit-wager-transaction.ts",
    find: "if (!existing.matchesPayload(transaction.payloadHash)) {",
    replace: "if (false as boolean) {",
    tests: ["test/integration/settlement.test.ts"],
  },
  {
    id: "inbox-record",
    protection: "the inbox: a message already recorded is treated as new",
    guards: "T-01, T-03",
    file: "src/wagering/infrastructure/persistence/mikro-orm-unit-of-work.ts",
    find: "if (inserted.length > 0) return { inserted: true };",
    replace: "return { inserted: true };",
    tests: ["test/integration/inbox.test.ts"],
  },
  {
    id: "inbox-hash",
    protection: "the check that a redelivered message has the same content",
    guards: "T-01",
    file: "src/wagering/application/submit-wager-transaction.ts",
    find: "if (seen.payloadHash !== transaction.payloadHash) {",
    replace: "if (false as boolean) {",
    tests: ["test/integration/inbox.test.ts"],
  },
  {
    id: "ack-before-commit",
    protection: "acknowledging only after the use case returned",
    guards: "T-03",
    file: "src/wagering/infrastructure/messaging/wager-queue-consumer.ts",
    find: "const { messageId, command } = parseWagerMessage(message.Body);",
    replace:
      "const { messageId, command } = parseWagerMessage(message.Body);\n      await this.acknowledge(queues.input, message);",
    tests: ["test/integration/consumer-failures.test.ts", "test/integration/consumer.test.ts"],
  },
  {
    id: "outbox-lease",
    protection: "the lease: a claimed outbox row stays visible to other publishers",
    guards: "T-03",
    file: "src/wagering/infrastructure/persistence/mikro-orm-outbox-store.ts",
    find: "[new Date(now.getTime() + leaseMs), now, limit]",
    replace: "[now, now, limit]",
    tests: ["test/integration/outbox-publisher.test.ts"],
  },
  {
    id: "outbox-skip-locked",
    protection: "SKIP LOCKED on the outbox claim",
    guards: "T-03",
    file: "src/wagering/infrastructure/persistence/mikro-orm-outbox-store.ts",
    find: "for update skip locked) due",
    replace: "for update) due",
    tests: ["test/integration/outbox-publisher.test.ts"],
  },
  {
    id: "reference-skip-locked",
    protection: "SKIP LOCKED on the pending-reference claim",
    guards: "T-04, FR-45",
    file: "src/wagering/infrastructure/persistence/mikro-orm-pending-reference-store.ts",
    find: "for update skip locked) due",
    replace: "for update) due",
    tests: ["test/integration/reference-worker.test.ts"],
  },
  {
    id: "publish-before-mark",
    protection: "marking an outbox row published only after the broker accepted it",
    guards: "T-03",
    file: "src/wagering/application/publish-outbox.ts",
    find: "        result = await this.publisher.publishBatch(toSend);",
    replace:
      "        await this.store.markPublished(\n          toSend.map((e) => e.id),\n          this.clock.now(),\n        );\n        result = await this.publisher.publishBatch(toSend);",
    tests: ["test/integration/outbox-publisher.test.ts"],
  },
  {
    id: "attempts-bound",
    protection: "the delivery limit: a message is never dead-lettered for running out of attempts",
    guards: "T-10",
    file: "src/wagering/infrastructure/messaging/wager-queue-consumer.ts",
    find: "const exhausted = !permanent && receives >= this.options.maxReceives;",
    replace: "const exhausted = false;",
    tests: ["test/integration/consumer-failures.test.ts"],
    filter: "bounded",
  },
  {
    id: "permanent-failure",
    protection: "dead-lettering a permanent failure at once",
    guards: "T-10",
    file: "src/wagering/infrastructure/messaging/wager-queue-consumer.ts",
    find: 'const permanent = classifyFailure(error) === "dead-letter";',
    replace: "const permanent = false;",
    tests: ["test/integration/consumer-failures.test.ts"],
    filter: "permanent failure",
  },
  {
    id: "consumer-database-gate",
    protection: "not receiving while the database does not answer",
    guards: "FR-101",
    file: "src/wagering/infrastructure/messaging/wager-queue-consumer.ts",
    find: "if (!this.options.databaseIsUp) return true;",
    replace: "return true;",
    tests: ["test/integration/consumer-failures.test.ts"],
    filter: "PostgreSQL is away",
  },
  {
    id: "reconciliation-bound",
    protection: "the bound on concurrent reconciliations",
    guards: "T-16, FR-102",
    file: "src/wagering/application/reconcile-wallet.ts",
    find: "if (this.running >= this.maxConcurrent) {",
    replace: "if (false as boolean) {",
    tests: ["test/unit/application/reconcile-wallet.test.ts"],
  },
  {
    id: "reconciliation-sign",
    protection: "the sign of the reconciliation difference (stored minus calculated)",
    guards: "T-09",
    file: "src/wagering/application/reconcile-wallet.ts",
    find: "snapshot.storedBalance.subtract(calculatedBalance)",
    replace: "calculatedBalance.subtract(snapshot.storedBalance)",
    tests: ["test/unit/application/reconcile-wallet.test.ts", "test/integration/reconciliation.test.ts"],
  },
  {
    id: "retention-unpublished-guard",
    protection: "never deleting an outbox row that was not published",
    guards: "T-15, FR-104",
    file: "src/wagering/infrastructure/persistence/mikro-orm-retention-store.ts",
    find: "where published_at is not null and published_at < ?",
    replace: "where occurred_at < ?",
    tests: ["test/integration/retention.test.ts"],
  },
  {
    id: "player-wallet-check",
    protection: "refusing a transaction for another player's wallet",
    guards: "T-05",
    file: "src/wagering/domain/settlement-policy.ts",
    find: 'if (transaction.playerId !== wallet.playerId) return reject("PLAYER_WALLET_MISMATCH");',
    replace: "",
    tests: ["test/unit/domain/settlement-policy.test.ts"],
  },
  {
    id: "ledger-append-only",
    protection: "the trigger that refuses updating or deleting a ledger entry",
    guards: "T-09",
    file: "migrations/Migration20261105130000_immutability_triggers.ts",
    find: "create trigger tr_ledger_append_only before update or delete or truncate on wallet_ledger_entries",
    replace: "create trigger tr_ledger_append_only before truncate on wallet_ledger_entries",
    tests: ["test/integration/schema.test.ts"],
  },
  {
    id: "security-headers-before-parser",
    protection: "the security headers on answers the body parser refuses",
    guards: "T-17, FR-100",
    file: "src/app.ts",
    find: "  app.use(securityHeadersMiddleware);\n",
    replace: "",
    tests: ["test/integration/openapi.test.ts"],
  },
];
