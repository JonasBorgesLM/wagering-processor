// Seeds the throwaway database the stress scenarios target with the one wallet they bet on, rich enough that it never
// runs out of funds: the stress is on the lock and the pipeline, not on a business rejection. It goes through the real
// use case. The ids are the ones in stress/scenarios/*.yaml.
//
//   DATABASE_URL=... bun run scripts/seed-stress.ts
import { MikroORM } from "@mikro-orm/postgresql";
import { loadConfig } from "../src/platform/config/config";
import { createOrmConfig } from "../src/platform/database/mikro-orm.config";
import { OpenWallet } from "../src/wagering/application/open-wallet";
import { Money } from "../src/wagering/domain/money";
import { MikroOrmUnitOfWork } from "../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work";
import { wageringEntitySchemas } from "../src/wagering/infrastructure/persistence/schemas";
import { SystemClock, UuidV7Generator } from "../src/wagering/infrastructure/system";

const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";
const PLAYER_ID = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";

/** The first id it hands out is the one asked for (the wallet's), and the rest are ordinary. */
const ids = new UuidV7Generator();
let given = false;
const firstIsTheWallet = {
  next: () => {
    if (given) return ids.next();
    given = true;
    return WALLET_ID;
  },
};

const config = loadConfig();
const orm = await MikroORM.init(createOrmConfig(config.databaseUrl, "migrations", wageringEntitySchemas));
try {
  const clock = new SystemClock();
  const unitOfWork = new MikroOrmUnitOfWork(orm, clock, { lockTimeoutMs: 2_000, statementTimeoutMs: 5_000 });
  await new OpenWallet(unitOfWork, clock, firstIsTheWallet).execute({
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount: "100000000.00", currency: "BRL" }),
    correlationId: "seed-stress",
  });
  console.log(JSON.stringify({ level: "info", message: "Seeded for the stress run", walletId: WALLET_ID }));
} finally {
  await orm.close();
}
