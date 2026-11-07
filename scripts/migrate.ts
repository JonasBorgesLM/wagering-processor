import { MikroORM } from "@mikro-orm/postgresql";
import { loadConfig } from "../src/platform/config/config";
import { createOrmConfig } from "../src/platform/database/mikro-orm.config";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  console.error("Usage: bun run migrate <up|down>");
  process.exit(2);
}

const orm = await MikroORM.init(createOrmConfig(loadConfig().databaseUrl));
try {
  const applied = direction === "up" ? await orm.migrator.up() : await orm.migrator.down();
  console.log(
    JSON.stringify({
      level: "info",
      message: `Migrations ${direction}`,
      applied: applied.map((m) => m.name),
    }),
  );
} finally {
  await orm.close();
}
