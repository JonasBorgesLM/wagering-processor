import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { type DynamicModule, Module } from "@nestjs/common";
import type { AppConfig } from "../../platform/config/config";
import { APP_CONFIG } from "../../platform/config/config.module";
import { OpenWallet } from "../application/open-wallet";
import type { Clock, IdGenerator, TransactionReader, UnitOfWork, WalletReader } from "../application/ports";
import { QueryTransactions } from "../application/query-transactions";
import { QueryWallets } from "../application/query-wallets";
import { SubmitWagerTransaction } from "../application/submit-wager-transaction";
import { TransactionsController } from "./http/transactions.controller";
import { WalletsController } from "./http/wallets.controller";
import { WagerQueueConsumer } from "./messaging/wager-queue-consumer";
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

/** Every controller that serves business routes, so a test can check that each carries the auth guard. */
export const BUSINESS_CONTROLLERS = [WalletsController, TransactionsController];

@Module({})
export class WageringModule {
  /** `api` decides whether this process serves HTTP at all: a process running only the publisher has no routes (ADR-0001). */
  static register(options: { api: boolean; consumer: boolean }): DynamicModule {
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
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
            new SubmitWagerTransaction(uow, clock, ids),
        },
        ...(options.consumer
          ? [
              {
                provide: WagerQueueConsumer,
                inject: [SQSClient, SubmitWagerTransaction, APP_CONFIG],
                useFactory: (sqs: SQSClient, useCase: SubmitWagerTransaction, config: AppConfig) =>
                  new WagerQueueConsumer(sqs, useCase, config.queueWaitSeconds),
              },
            ]
          : []),
      ],
      controllers: options.api ? BUSINESS_CONTROLLERS : [],
      exports: [OpenWallet, QueryWallets, UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    };
  }
}
