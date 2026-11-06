import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { type DynamicModule, Logger, Module } from "@nestjs/common";
import { type AppConfig, MAX_RECEIVE_COUNT } from "../../platform/config/config";
import { APP_CONFIG } from "../../platform/config/config.module";
import { DrainState } from "../../platform/lifecycle/drain-state";
import { PollingWorker } from "../../platform/lifecycle/polling-worker";
import { backoffSeconds } from "../../platform/resilience/backoff";
import { OpenWallet } from "../application/open-wallet";
import type {
  Clock,
  EventPublisher,
  IdGenerator,
  OutboxStore,
  PendingReferenceStore,
  TransactionReader,
  UnitOfWork,
  WalletReader,
} from "../application/ports";
import { PublishOutbox } from "../application/publish-outbox";
import { QueryTransactions } from "../application/query-transactions";
import { QueryWallets } from "../application/query-wallets";
import { SettleWaitingReferences } from "../application/settle-waiting-references";
import { SubmitWagerTransaction } from "../application/submit-wager-transaction";
import { TransactionsController } from "./http/transactions.controller";
import { WalletsController } from "./http/wallets.controller";
import { SqsEventPublisher } from "./messaging/sqs-event-publisher";
import { WagerQueueConsumer } from "./messaging/wager-queue-consumer";
import { MikroOrmOutboxStore } from "./persistence/mikro-orm-outbox-store";
import { MikroOrmPendingReferenceStore } from "./persistence/mikro-orm-pending-reference-store";
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
    const limits = (config: AppConfig) => ({
      lockTimeoutMs: config.lockTimeoutMs,
      statementTimeoutMs: config.statementTimeoutMs,
    });
    return {
      module: WageringModule,
      providers: [
        { provide: CLOCK, useValue: new SystemClock() },
        { provide: ID_GENERATOR, useValue: new UuidV7Generator() },
        {
          provide: UNIT_OF_WORK,
          inject: [MikroORM, CLOCK, APP_CONFIG],
          useFactory: (orm: MikroORM, clock: Clock, config: AppConfig) =>
            new MikroOrmUnitOfWork(orm, clock, limits(config)),
        },
        {
          provide: WALLET_READER,
          inject: [MikroORM, APP_CONFIG],
          useFactory: (orm: MikroORM, config: AppConfig) => new MikroOrmWalletReader(orm, limits(config)),
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
          inject: [MikroORM, APP_CONFIG],
          useFactory: (orm: MikroORM, config: AppConfig) =>
            new MikroOrmTransactionReader(orm, limits(config)),
        },
        {
          provide: QueryTransactions,
          inject: [TRANSACTION_READER],
          useFactory: (reader: TransactionReader) => new QueryTransactions(reader),
        },
        {
          provide: SubmitWagerTransaction,
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, APP_CONFIG],
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, config: AppConfig) =>
            new SubmitWagerTransaction(uow, clock, ids, {
              firstReferenceRetryMs: config.referenceRetryBaseSeconds * 1000,
            }),
        },
        ...(options.publisher
          ? [
              {
                provide: OUTBOX_STORE,
                inject: [MikroORM, APP_CONFIG],
                useFactory: (orm: MikroORM, config: AppConfig) =>
                  new MikroOrmOutboxStore(orm, limits(config)),
              },
              {
                provide: EVENT_PUBLISHER,
                inject: [SQSClient],
                useFactory: (sqs: SQSClient) => new SqsEventPublisher(sqs),
              },
              {
                provide: PublishOutbox,
                inject: [OUTBOX_STORE, EVENT_PUBLISHER, CLOCK, APP_CONFIG],
                useFactory: (
                  store: OutboxStore,
                  publisher: EventPublisher,
                  clock: Clock,
                  config: AppConfig,
                ) =>
                  new PublishOutbox(store, publisher, clock, {
                    batchSize: config.outboxBatchSize,
                    leaseMs: config.outboxLeaseMs,
                    retryDelayMs: (attempts) =>
                      1000 *
                      backoffSeconds(attempts, {
                        baseSeconds: config.outboxRetryBaseSeconds,
                        capSeconds: config.outboxRetryCapSeconds,
                      }),
                  }),
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
                inject: [MikroORM, APP_CONFIG],
                useFactory: (orm: MikroORM, config: AppConfig) =>
                  new MikroOrmPendingReferenceStore(orm, limits(config)),
              },
              {
                provide: SettleWaitingReferences,
                inject: [PENDING_REFERENCE_STORE, UNIT_OF_WORK, CLOCK, ID_GENERATOR, APP_CONFIG],
                useFactory: (
                  store: PendingReferenceStore,
                  uow: UnitOfWork,
                  clock: Clock,
                  ids: IdGenerator,
                  config: AppConfig,
                ) =>
                  new SettleWaitingReferences(store, uow, clock, ids, {
                    batchSize: config.referenceBatchSize,
                    leaseMs: config.referenceLeaseMs,
                    ttlMs: config.referenceTtlSeconds * 1000,
                    retryDelayMs: (attempts) =>
                      1000 *
                      backoffSeconds(attempts, {
                        baseSeconds: config.referenceRetryBaseSeconds,
                        capSeconds: config.referenceRetryCapSeconds,
                      }),
                  }),
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
                inject: [SQSClient, SubmitWagerTransaction, APP_CONFIG, DrainState],
                useFactory: (
                  sqs: SQSClient,
                  useCase: SubmitWagerTransaction,
                  config: AppConfig,
                  drain: DrainState,
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
