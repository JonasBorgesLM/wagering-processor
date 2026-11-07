// Seeds the throwaway database that the security scan targets with the rows the OpenAPI examples name, so that a
// scanner using those examples as its benign values reaches code that reads a wallet or a transaction, instead of
// being answered 404 before anything it sends could matter. It goes through the real use cases, not SQL.
//
//   DATABASE_URL=... bun run scripts/seed-scan.ts
import { MikroORM } from "@mikro-orm/postgresql";
import { loadConfig } from "../src/platform/config/config";
import { createOrmConfig } from "../src/platform/database/mikro-orm.config";
import { OpenWallet } from "../src/wagering/application/open-wallet";
import { SubmitWagerTransaction } from "../src/wagering/application/submit-wager-transaction";
import { Money } from "../src/wagering/domain/money";
import { MikroOrmUnitOfWork } from "../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work";
import { wageringEntitySchemas } from "../src/wagering/infrastructure/persistence/schemas";
import { SystemClock, UuidV7Generator } from "../src/wagering/infrastructure/system";

// The ids and names in docs/openapi.yaml.
const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";
const PLAYER_ID = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
const TRANSACTION_ID = "0192f298-345e-7e38-af88-e43f851a819d";

/** The first id it hands out is the one asked for, and the rest are ordinary. */
const firstIs = (first: string) => {
  const rest = new UuidV7Generator();
  let given = false;
  return {
    next: () => {
      if (given) return rest.next();
      given = true;
      return first;
    },
  };
};

const config = loadConfig();
const orm = await MikroORM.init(createOrmConfig(config.databaseUrl, "migrations", wageringEntitySchemas));
try {
  const clock = new SystemClock();
  const unitOfWork = new MikroOrmUnitOfWork(orm, clock, { lockTimeoutMs: 2_000, statementTimeoutMs: 5_000 });
  const money = (amount: string) => Money.from({ amount, currency: "BRL" });

  await new OpenWallet(unitOfWork, clock, firstIs(WALLET_ID)).execute({
    playerId: PLAYER_ID,
    initialBalance: money("1000.00"),
    correlationId: "seed-scan",
  });
  await new SubmitWagerTransaction(unitOfWork, clock, firstIs(TRANSACTION_ID)).execute({
    idempotencyKey: "provider-a:transaction-123",
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET" as never,
    money: money("25.00"),
    correlationId: "seed-scan",
  });
  console.log(
    JSON.stringify({
      level: "info",
      message: "Seeded for the security scan",
      walletId: WALLET_ID,
      transactionId: TRANSACTION_ID,
    }),
  );
} finally {
  await orm.close();
}
