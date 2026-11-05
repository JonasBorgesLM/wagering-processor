import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EntitySchema, LockMode, MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../src/platform/database/mikro-orm.config";
import { createTestDatabase, type TestDatabase } from "../support/database";

// Runtime contracts ARCHITECTURE.md depends on, checked on Bun against real PostgreSQL.

// A persistence record, not a domain class: EntitySchema cannot map a private
// constructor, which is one reason ADR-0002 keeps the two apart.
class Account {
  id!: string;
  balance!: string;
}

const AccountSchema = new EntitySchema<Account>({
  class: Account,
  tableName: "account",
  properties: {
    id: { type: "string", primary: true },
    balance: { type: "decimal", columnType: "numeric(20,2)" },
  },
});

let database: TestDatabase;
let orm: MikroORM;

beforeAll(async () => {
  database = await createTestDatabase();
  orm = await MikroORM.init({
    ...createOrmConfig(database.url, "test/fixtures/migrations"),
    entities: [AccountSchema],
  });
  const connection = orm.em.getConnection();
  await connection.execute("create table account (id text primary key, balance numeric(20,2) not null)");
  await connection.execute(
    "create table entry (id serial primary key, account_id text not null references account(id))",
  );
  await connection.execute("insert into account values ('a1', '100.00'), ('a2', '100.00')");
});

afterAll(async () => {
  await orm.close();
  await database.drop();
});

describe("migrator", () => {
  const tableExists = async () => {
    const rows = await orm.em.getConnection().execute("select to_regclass('probe') is not null as present");
    return rows[0]?.present as boolean;
  };

  test("NFR-01: applies and reverts a migration", async () => {
    await orm.migrator.up();
    expect(await tableExists()).toBe(true);
    await orm.migrator.down();
    expect(await tableExists()).toBe(false);
  });
});

describe("numeric mapping", () => {
  test("FR-02: NUMERIC reaches the application as an exact string, never a number", async () => {
    const rows = await orm.em.getConnection().execute("select 12345678901234567.89::numeric(20,2) as amount");
    expect(rows[0]?.amount).toBe("12345678901234567.89");
  });
});

describe("wallet lock", () => {
  test("NFR-03: LockMode.PESSIMISTIC_WRITE serializes read-calculate-update across connections", async () => {
    const debit = () =>
      orm.em.fork().transactional(async (em) => {
        const account = await em.findOneOrFail(
          Account,
          { id: "a1" },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        await Bun.sleep(5);
        account.balance = (BigInt(account.balance.replace(".", "")) - 100n)
          .toString()
          .replace(/(\d{2})$/, ".$1");
      });
    await Promise.all(Array.from({ length: 20 }, debit));
    const rows = await orm.em.getConnection().execute("select balance from account where id = 'a1'");
    expect(rows[0]?.balance).toBe("80.00");
  });

  // Why ADR-0003 takes the wallet lock before inserting a transaction row.
  test("inserting a child row before FOR UPDATE deadlocks", async () => {
    const insertThenLock = () =>
      orm.em.fork().transactional(async (em) => {
        const connection = em.getConnection();
        await connection.execute(
          "insert into entry (account_id) values ('a2')",
          [],
          "run",
          em.getTransactionContext(),
        );
        await Bun.sleep(100);
        await connection.execute(
          "select id from account where id = 'a2' for update",
          [],
          "all",
          em.getTransactionContext(),
        );
      });
    const results = await Promise.allSettled([insertThenLock(), insertThenLock()]);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain("deadlock");
  });

  test("taking FOR UPDATE before inserting the child row does not deadlock", async () => {
    const lockThenInsert = () =>
      orm.em.fork().transactional(async (em) => {
        const connection = em.getConnection();
        await connection.execute(
          "select id from account where id = 'a2' for update",
          [],
          "all",
          em.getTransactionContext(),
        );
        await Bun.sleep(100);
        await connection.execute(
          "insert into entry (account_id) values ('a2')",
          [],
          "run",
          em.getTransactionContext(),
        );
      });
    const results = await Promise.allSettled([lockThenInsert(), lockThenInsert()]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});
