import type { MikroORM } from "@mikro-orm/postgresql";
import type { TransactionReader } from "../../application/ports";
import { transactionFromRecord } from "./mappers";
import { boundedTransaction, type UnitOfWorkOptions } from "./mikro-orm-unit-of-work";
import { WagerTransactionSchema } from "./schemas";

/** Both lookups are unique indexes, so each is one row and a single index probe. */
export class MikroOrmTransactionReader implements TransactionReader {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
  ) {}

  findById(id: string) {
    return boundedTransaction(this.orm, this.options, async (em) => {
      const record = await em.findOne(WagerTransactionSchema, { id }, { disableIdentityMap: true });
      return record ? transactionFromRecord(record) : undefined;
    });
  }

  findByExternalId(providerId: string, externalTransactionId: string) {
    return boundedTransaction(this.orm, this.options, async (em) => {
      const record = await em.findOne(
        WagerTransactionSchema,
        { providerId, externalTransactionId },
        { disableIdentityMap: true },
      );
      return record ? transactionFromRecord(record) : undefined;
    });
  }
}
