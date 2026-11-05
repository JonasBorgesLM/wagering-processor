import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../src/platform/database/mikro-orm.config";
import { TEST_ENV } from "./env";

export interface TestDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

/** One real database per test file, so parallel files cannot observe each other. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = await MikroORM.init(createOrmConfig(TEST_ENV.DATABASE_URL));
  await admin.em.getConnection().execute(`create database ${name}`);
  await admin.close();

  const url = new URL(TEST_ENV.DATABASE_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const orm = await MikroORM.init(createOrmConfig(TEST_ENV.DATABASE_URL));
      await orm.em.getConnection().execute(`drop database if exists ${name} with (force)`);
      await orm.close();
    },
  };
}
