import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";

export function createOrmConfig(databaseUrl: string, migrationsPath = "migrations") {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      path: migrationsPath,
      tableName: "schema_migrations",
      // Every migration must be reversible (NFR-01); `snapshot` would hide schema drift between them.
      snapshot: false,
      allOrNothing: true,
    },
  });
}
