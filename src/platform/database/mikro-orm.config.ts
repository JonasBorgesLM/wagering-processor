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
  pool: { max?: number; acquireTimeoutMs?: number } = {},
) {
  return defineConfig({
    clientUrl: databaseUrl,
    // Bounded on both sides (NFR-11). `max` caps what one process takes from the database, and the acquire timeout
    // caps how long a request waits when that many are busy. Without the second, a burst on one hot wallet queues
    // every other request behind connections that are themselves waiting for its lock.
    ...(pool.max === undefined ? {} : { pool: { max: pool.max } }),
    ...(pool.acquireTimeoutMs === undefined
      ? {}
      : { driverOptions: { connectionTimeoutMillis: pool.acquireTimeoutMs } }),
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
