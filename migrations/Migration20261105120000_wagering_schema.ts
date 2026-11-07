import { Migration } from "@mikro-orm/migrations";

/**
 * What must hold even if the application is wrong (NFR-02, §5.9). Every
 * constraint is named, because its tests assert which one refused a row: a test
 * that only expects "an error" passes when the insert fails for another reason.
 *
 * Each constraint stays on one line, which also lets a mutation run remove them
 * one at a time and watch the matching test go red.
 *
 * A CHECK passes when its expression is NULL, so anything comparing a nullable
 * column must say what NULL means: that is what the coalesce in the failure-code
 * check is for. Without it, a rejection with no code was accepted.
 */
export class Migration20261105120000_wagering_schema extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(20,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint uq_wallets_player_currency unique (player_id, currency),
        constraint uq_wallets_id_currency unique (id, currency),
        constraint ck_wallets_currency check (currency ~ '^[A-Z]{3}$'),
        constraint ck_wallets_balance_non_negative check (balance >= 0),
        constraint ck_wallets_version_positive check (version >= 1)
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(255) not null,
        external_transaction_id varchar(255) not null,
        idempotency_key varchar(255) not null,
        payload_hash varchar(64) not null,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id varchar(255) not null,
        game_id varchar(255) not null,
        kind varchar(16) not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        reference_external_transaction_id varchar(255),
        reference_transaction_id uuid,
        status varchar(32) not null,
        failure_code varchar(64),
        observed_balance numeric(20,2),
        processed_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint uq_wager_transactions_idempotency_key unique (idempotency_key),
        constraint uq_wager_transactions_provider_external unique (provider_id, external_transaction_id),
        constraint uq_wager_transactions_id_wallet unique (id, wallet_id),
        constraint fk_wager_transactions_wallet foreign key (wallet_id) references wallets (id),
        constraint fk_wager_transactions_reference_same_wallet foreign key (reference_transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        constraint ck_wager_transactions_kind check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint ck_wager_transactions_status check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint ck_wager_transactions_currency check (currency ~ '^[A-Z]{3}$'),
        constraint ck_wager_transactions_amount_non_negative check (amount >= 0),
        constraint ck_wager_transactions_only_loss_may_be_zero check (amount > 0 or kind = 'LOSS'),
        constraint ck_wager_transactions_reversal_needs_reference check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint ck_wager_transactions_standalone_has_no_reference check (kind not in ('BET', 'OPENING') or reference_external_transaction_id is null),
        constraint ck_wager_transactions_no_self_reference check (reference_external_transaction_id <> external_transaction_id),
        constraint ck_wager_transactions_opening_is_internal check ((kind = 'OPENING') = (provider_id = 'internal')),
        constraint ck_wager_transactions_failure_code check ((status = 'REJECTED' and coalesce(failure_code, '') in ('INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'CURRENCY_MISMATCH', 'PLAYER_WALLET_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH', 'REFERENCE_KIND_NOT_ALLOWED', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_AMOUNT_MISMATCH', 'ALREADY_REVERSED', 'BALANCE_LIMIT_EXCEEDED')) or (status = 'FAILED' and coalesce(failure_code, '') = 'SETTLEMENT_FAILED') or (status not in ('REJECTED', 'FAILED') and failure_code is null)),
        constraint ck_wager_transactions_processed_at check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint ck_wager_transactions_observed_balance_non_negative check (observed_balance >= 0),
        constraint ck_wager_transactions_observed_balance_required check (status not in ('PROCESSED', 'PENDING_REFERENCE') or observed_balance is not null),
        constraint ck_wager_transactions_reference_link check ((reference_transaction_id is null or status = 'PROCESSED') and (status <> 'PROCESSED' or (reference_external_transaction_id is null) = (reference_transaction_id is null)))
      )
    `);
    // The single-reversal rule (ADR-0006). Partial, so a rejected attempt does not use the reference up (FR-27),
    // and only reversals count, so several WINs may point at one BET (FR-23).
    this.addSql(
      `create unique index uq_wager_transactions_single_reversal on wager_transactions (reference_transaction_id) where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`,
    );

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction varchar(8) not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        wallet_version integer not null,
        created_at timestamptz not null,
        constraint uq_ledger_one_entry_per_transaction unique (transaction_id),
        constraint uq_ledger_wallet_version unique (wallet_id, wallet_version),
        constraint fk_ledger_wallet_same_currency foreign key (wallet_id, currency) references wallets (id, currency),
        constraint fk_ledger_transaction_same_wallet foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        constraint ck_ledger_amount_positive check (amount > 0),
        constraint ck_ledger_balance_before_non_negative check (balance_before >= 0),
        constraint ck_ledger_balance_after_non_negative check (balance_after >= 0),
        constraint ck_ledger_version_positive check (wallet_version >= 1),
        constraint ck_ledger_arithmetic check ((direction = 'CREDIT' and balance_after = balance_before + amount) or (direction = 'DEBIT' and balance_after = balance_before - amount))
      )
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(255) not null,
        message_id varchar(255) not null,
        payload_hash varchar(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint pk_inbox_messages primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type varchar(128) not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz,
        constraint ck_outbox_attempts_non_negative check (attempts >= 0)
      )
    `);
    this.addSql("create index ix_outbox_due on outbox_messages (next_attempt_at) where published_at is null");
  }

  override down(): void {
    this.addSql("drop table outbox_messages");
    this.addSql("drop table inbox_messages");
    this.addSql("drop table wallet_ledger_entries");
    this.addSql("drop table wager_transactions");
    this.addSql("drop table wallets");
  }
}
