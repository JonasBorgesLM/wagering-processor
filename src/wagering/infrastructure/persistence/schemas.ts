import { EntitySchema } from "@mikro-orm/postgresql";
import type { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from "./records";

// Mapping only. The tables and every constraint come from the migrations, so nothing here generates a schema,
// and a test compares these properties with the real columns to catch the two drifting apart.
//
// What keeps an amount exact is the column type: with `numeric(20,2)` the ORM resolves the property to its
// DecimalType and reads a string, whatever `type` says (checked: declaring it as a number changes nothing, and
// 2^53 + 1 still comes back intact). `type` is kept for the reader, and a test compares the resolved runtime type
// and nullability with the real columns. Property names are camelCase and the default naming strategy maps them
// to snake_case.

const amount = { type: "string", columnType: "numeric(20,2)" } as const;
const instant = { type: "Date", columnType: "timestamptz" } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", columnType: "char(3)" },
    balance: amount,
    version: { type: "integer" },
    createdAt: instant,
    updatedAt: instant,
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", columnType: "varchar(255)" },
    externalTransactionId: { type: "string", columnType: "varchar(255)" },
    idempotencyKey: { type: "string", columnType: "varchar(255)" },
    payloadHash: { type: "string", columnType: "varchar(64)" },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    roundId: { type: "string", columnType: "varchar(255)" },
    gameId: { type: "string", columnType: "varchar(255)" },
    kind: { type: "string", columnType: "varchar(16)" },
    amount,
    currency: { type: "string", columnType: "char(3)" },
    referenceExternalTransactionId: { type: "string", columnType: "varchar(255)", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string", columnType: "varchar(32)" },
    failureCode: { type: "string", columnType: "varchar(64)", nullable: true },
    observedBalance: { ...amount, nullable: true },
    processedAt: { ...instant, nullable: true },
    createdAt: instant,
    updatedAt: instant,
    retryAttempts: { type: "integer" },
    nextRetryAt: { ...instant, nullable: true },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: "LedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "string", columnType: "varchar(8)" },
    amount,
    currency: { type: "string", columnType: "char(3)" },
    balanceBefore: amount,
    balanceAfter: amount,
    walletVersion: { type: "integer" },
    createdAt: instant,
  },
});

/** What the composition root hands to `createOrmConfig`. */
export const wageringEntitySchemas = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema];
