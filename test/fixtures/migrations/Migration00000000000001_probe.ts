import { Migration } from "@mikro-orm/migrations";

/** Fixture only: proves the migrator runs both directions on Bun, without shipping a fake production migration. */
export class Migration00000000000001_probe extends Migration {
  override up(): void {
    this.addSql("create table probe (id int primary key)");
  }

  override down(): void {
    this.addSql("drop table probe");
  }
}
