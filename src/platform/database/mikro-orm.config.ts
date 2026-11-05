import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type EntitySchema } from "@mikro-orm/postgresql";

/**
 * `entities` is passed in rather than imported: platform knows no business code,
 * so whatever composes the application says which records the ORM maps.
 */
export function createOrmConfig(
  databaseUrl: string,
  migrationsPath = "migrations",
  entities: EntitySchema[] = [],
) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities,
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
