import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { type DynamicModule, Logger, Module } from "@nestjs/common";
import { Registry } from "prom-client";
import { type AppConfig, MAX_RECEIVE_COUNT } from "../../platform/config/config";
import { APP_CONFIG } from "../../platform/config/config.module";
import { DrainState } from "../../platform/lifecycle/drain-state";
import { PollingWorker } from "../../platform/lifecycle/polling-worker";
import { MetricsModule } from "../../platform/metrics/metrics.module";
import { backoffSeconds } from "../../platform/resilience/backoff";
import { OpenWallet } from "../application/open-wallet";
import type {
  Clock,
  DivergenceReporter,
  EventPublisher,
  IdGenerator,
  OutboxStore,
  PendingReferenceStore,
  ReconciliationReader,
  TransactionReader,
  TransientReason,
  UnitOfWork,
  WageringMetrics,
  WalletReader,
} from "../application/ports";
import { PublishOutbox } from "../application/publish-outbox";
import { QueryTransactions } from "../application/query-transactions";
import { QueryWallets } from "../application/query-wallets";
import { ReconcileWallet } from "../application/reconcile-wallet";
import { SettleWaitingReferences } from "../application/settle-waiting-references";
import { SubmitWagerTransaction } from "../application/submit-wager-transaction";
import { TransactionsController } from "./http/transactions.controller";
import { WalletsController } from "./http/wallets.controller";
import { SqsEventPublisher } from "./messaging/sqs-event-publisher";
import { WagerQueueConsumer } from "./messaging/wager-queue-consumer";
import { PrometheusDivergenceReporter } from "./metrics/prometheus-divergence-reporter";
import { PrometheusMetrics, registerOutboxGauges } from "./metrics/prometheus-metrics";
import { measureOutbox } from "./persistence/mikro-orm-outbox-lag";
import { MikroOrmOutboxStore } from "./persistence/mikro-orm-outbox-store";
import { MikroOrmPendingReferenceStore } from "./persistence/mikro-orm-pending-reference-store";
import { MikroOrmReconciliationReader } from "./persistence/mikro-orm-reconciliation-reader";
import { MikroOrmTransactionReader } from "./persistence/mikro-orm-transaction-reader";
import { MikroOrmUnitOfWork } from "./persistence/mikro-orm-unit-of-work";
import { MikroOrmWalletReader } from "./persistence/mikro-orm-wallet-reader";
import { SystemClock, UuidV7Generator } from "./system";

// Nest tokens for the application's ports, which are interfaces and so have no runtime identity of their own.
export const CLOCK = Symbol("CLOCK");
export const ID_GENERATOR = Symbol("ID_GENERATOR");
export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
export const WALLET_READER = Symbol("WALLET_READER");
export const TRANSACTION_READER = Symbol("TRANSACTION_READER");
export const OUTBOX_STORE = Symbol("OUTBOX_STORE");
export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");
export const OUTBOX_WORKER = Symbol("OUTBOX_WORKER");
export const PENDING_REFERENCE_STORE = Symbol("PENDING_REFERENCE_STORE");
export const REFERENCE_WORKER = Symbol("REFERENCE_WORKER");
export const RECONCILIATION_READER = Symbol("RECONCILIATION_READER");
export const DIVERGENCE_REPORTER = Symbol("DIVERGENCE_REPORTER");
export const METRICS = Symbol("METRICS");
export const OUTBOX_GAUGES = Symbol("OUTBOX_GAUGES");

/** Every controller that serves business routes, so a test can check that each carries the auth guard. */
export const BUSINESS_CONTROLLERS = [WalletsController, TransactionsController];

@Module({})
export class WageringModule {
  /** `api` decides whether this process serves HTTP at all: a process running only the publisher has no routes (ADR-0001). */
  static register(options: {
    api: boolean;
    consumer: boolean;
    publisher: boolean;
    referenceWorker: boolean;
  }): DynamicModule {
    const limits = (config: AppConfig, metrics: WageringMetrics) => ({
      lockTimeoutMs: config.lockTimeoutMs,
      statementTimeoutMs: config.statementTimeoutMs,
      onTransientFailure: (reason: TransientReason) => metrics.databaseTransient(reason),
    });
    return {
      module: WageringModule,
      imports: [MetricsModule],
      providers: [
        { provide: CLOCK, useValue: new SystemClock() },
        {
          provide: METRICS,
          inject: [Registry],
          useFactory: (registry: Registry) => new PrometheusMetrics(registry),
        },
        { provide: ID_GENERATOR, useValue: new UuidV7Generator() },
        {
          provide: UNIT_OF_WORK,
          inject: [MikroORM, CLOCK, APP_CONFIG, METRICS],
          useFactory: (orm: MikroORM, clock: Clock, config: AppConfig, metrics: WageringMetrics) =>
            new MikroOrmUnitOfWork(orm, clock, limits(config, metrics)),
        },
        {
          provide: WALLET_READER,
          inject: [MikroORM, APP_CONFIG, METRICS],
          useFactory: (orm: MikroORM, config: AppConfig, metrics: WageringMetrics) =>
            new MikroOrmWalletReader(orm, limits(config, metrics)),
        },
        {
          provide: OUTBOX_GAUGES,
          inject: [MikroORM, APP_CONFIG, METRICS, Registry],
          useFactory: (orm: MikroORM, config: AppConfig, metrics: WageringMetrics, registry: Registry) => {
            registerOutboxGauges(registry, measureOutbox(orm, limits(config, metrics)));
            return true;
          },
        },
        {
          provide: RECONCILIATION_READER,
          inject: [MikroORM, APP_CONFIG, METRICS],
          useFactory: (orm: MikroORM, config: AppConfig, metrics: WageringMetrics) =>
            new MikroOrmReconciliationReader(orm, limits(config, metrics)),
        },
        {
          provide: DIVERGENCE_REPORTER,
          inject: [Registry],
          useFactory: (registry: Registry) => new PrometheusDivergenceReporter(registry),
        },
        {
          provide: ReconcileWallet,
          inject: [RECONCILIATION_READER, DIVERGENCE_REPORTER],
          useFactory: (reader: ReconciliationReader, reporter: DivergenceReporter) =>
            new ReconcileWallet(reader, reporter),
        },
        {
          provide: OpenWallet,
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new OpenWallet(uow, clock, ids),
        },
        {
          provide: QueryWallets,
          inject: [WALLET_READER],
          useFactory: (reader: WalletReader) => new QueryWallets(reader),
        },
        {
          provide: TRANSACTION_READER,
          inject: [MikroORM, APP_CONFIG, METRICS],
          useFactory: (orm: MikroORM, config: AppConfig, metrics: WageringMetrics) =>
            new MikroOrmTransactionReader(orm, limits(config, metrics)),
        },
        {
          provide: QueryTransactions,
          inject: [TRANSACTION_READER],
          useFactory: (reader: TransactionReader) => new QueryTransactions(reader),
        },
        {
          provide: SubmitWagerTransaction,
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, APP_CONFIG, METRICS],
          useFactory: (
            uow: UnitOfWork,
            clock: Clock,
            ids: IdGenerator,
            config: AppConfig,
            metrics: WageringMetrics,
          ) =>
            new SubmitWagerTransaction(
              uow,
              clock,
              ids,
              { firstReferenceRetryMs: config.referenceRetryBaseSeconds * 1000 },
              metrics,
            ),
        },
        ...(options.publisher
          ? [
              {
                provide: OUTBOX_STORE,
                inject: [MikroORM, APP_CONFIG, METRICS],
                useFactory: (orm: MikroORM, config: AppConfig, metrics: WageringMetrics) =>
                  new MikroOrmOutboxStore(orm, limits(config, metrics)),
              },
              {
                provide: EVENT_PUBLISHER,
                inject: [SQSClient],
                useFactory: (sqs: SQSClient) => new SqsEventPublisher(sqs),
              },
              {
                provide: PublishOutbox,
                inject: [OUTBOX_STORE, EVENT_PUBLISHER, CLOCK, APP_CONFIG, METRICS],
                useFactory: (
                  store: OutboxStore,
                  publisher: EventPublisher,
                  clock: Clock,
                  config: AppConfig,
                  metrics: WageringMetrics,
                ) =>
                  new PublishOutbox(
                    store,
                    publisher,
                    clock,
                    {
                      batchSize: config.outboxBatchSize,
                      leaseMs: config.outboxLeaseMs,
                      retryDelayMs: (attempts) =>
                        1000 *
                        backoffSeconds(attempts, {
                          baseSeconds: config.outboxRetryBaseSeconds,
                          capSeconds: config.outboxRetryCapSeconds,
                        }),
                    },
                    metrics,
                  ),
              },
              {
                provide: OUTBOX_WORKER,
                inject: [PublishOutbox, APP_CONFIG, DrainState],
                useFactory: (useCase: PublishOutbox, config: AppConfig, drain: DrainState) => {
                  const logger = new Logger("OutboxPublisher");
                  return new PollingWorker(
                    "OutboxPublisher",
                    async () => {
                      const result = await useCase.runOnce();
                      if (result.published > 0) logger.log(`Published ${result.published} event(s)`);
                      if (result.failure !== undefined) {
                        logger.warn("Publishing failed; the events will be retried later", {
                          error: describe(result.failure),
                        });
                        return false;
                      }
                      // A full batch means there is probably more: go again at once instead of sleeping on a backlog.
                      return result.claimed > 0 && result.published === result.claimed;
                    },
                    config.outboxPollIntervalMs,
                    drain,
                  );
                },
              },
            ]
          : []),
        ...(options.referenceWorker
          ? [
              {
                provide: PENDING_REFERENCE_STORE,
                inject: [MikroORM, APP_CONFIG, METRICS],
                useFactory: (orm: MikroORM, config: AppConfig, metrics: WageringMetrics) =>
                  new MikroOrmPendingReferenceStore(orm, limits(config, metrics)),
              },
              {
                provide: SettleWaitingReferences,
                inject: [PENDING_REFERENCE_STORE, UNIT_OF_WORK, CLOCK, ID_GENERATOR, APP_CONFIG, METRICS],
                useFactory: (
                  store: PendingReferenceStore,
                  uow: UnitOfWork,
                  clock: Clock,
                  ids: IdGenerator,
                  config: AppConfig,
                  metrics: WageringMetrics,
                ) =>
                  new SettleWaitingReferences(
                    store,
                    uow,
                    clock,
                    ids,
                    {
                      batchSize: config.referenceBatchSize,
                      leaseMs: config.referenceLeaseMs,
                      ttlMs: config.referenceTtlSeconds * 1000,
                      retryDelayMs: (attempts) =>
                        1000 *
                        backoffSeconds(attempts, {
                          baseSeconds: config.referenceRetryBaseSeconds,
                          capSeconds: config.referenceRetryCapSeconds,
                        }),
                    },
                    metrics,
                  ),
              },
              {
                provide: REFERENCE_WORKER,
                inject: [SettleWaitingReferences, APP_CONFIG, DrainState],
                useFactory: (useCase: SettleWaitingReferences, config: AppConfig, drain: DrainState) => {
                  const logger = new Logger("ReferenceWorker");
                  return new PollingWorker(
                    "ReferenceWorker",
                    async () => {
                      const r = await useCase.runOnce();
                      if (r.claimed > 0) {
                        logger.log(
                          `Looked at ${r.claimed}: ${r.settled} settled, ${r.rejected} rejected, ${r.expired} expired, ${r.waiting} still waiting`,
                        );
                      }
                      if (r.transientFailures > 0) {
                        logger.warn(
                          `${r.transientFailures} could not be settled now; they will be tried again`,
                        );
                      }
                      for (const decision of r.decisions) {
                        logger.log("Waiting transaction decided", {
                          correlationId: decision.transactionId,
                          transactionId: decision.transactionId,
                          walletId: decision.walletId,
                          providerId: decision.providerId,
                          status: decision.status,
                          failureCode: decision.failureCode,
                        });
                      }
                      for (const error of r.errors) {
                        logger.error("A transaction could not be settled and is now FAILED", {
                          error: describe(error),
                        });
                      }
                      return r.claimed === config.referenceBatchSize;
                    },
                    config.referencePollIntervalMs,
                    drain,
                  );
                },
              },
            ]
          : []),
        ...(options.consumer
          ? [
              {
                provide: WagerQueueConsumer,
                inject: [SQSClient, SubmitWagerTransaction, APP_CONFIG, DrainState, METRICS],
                useFactory: (
                  sqs: SQSClient,
                  useCase: SubmitWagerTransaction,
                  config: AppConfig,
                  drain: DrainState,
                  metrics: WageringMetrics,
                ) =>
                  new WagerQueueConsumer(
                    sqs,
                    useCase,
                    {
                      waitSeconds: config.queueWaitSeconds,
                      backoff: {
                        baseSeconds: config.queueBackoffBaseSeconds,
                        capSeconds: config.queueBackoffCapSeconds,
                      },
                      maxReceives: MAX_RECEIVE_COUNT,
                    },
                    drain,
                    metrics,
                  ),
              },
            ]
          : []),
      ],
      controllers: options.api ? BUSINESS_CONTROLLERS : [],
      exports: [OpenWallet, QueryWallets, UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
