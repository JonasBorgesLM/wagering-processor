import type { MikroORM } from "@mikro-orm/postgresql";
import type { WalletReader } from "../../application/ports";
import { ledgerEntryFromRecord, walletFromRecord } from "./mappers";
import { boundedTransaction, type UnitOfWorkOptions } from "./mikro-orm-unit-of-work";
import { LedgerEntrySchema, WalletSchema } from "./schemas";

/**
 * Takes no lock: a read never waits for a settlement, and sees what is
 * committed. The ledger query is served by `uq_ledger_wallet_version`, which is
 * exactly (wallet, version), so a page is an index range scan and not a sort.
 */
export class MikroOrmWalletReader implements WalletReader {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
  ) {}

  findWallet(id: string) {
    return boundedTransaction(this.orm, this.options, async (em) => {
      const record = await em.findOne(WalletSchema, { id }, { disableIdentityMap: true });
      return record ? walletFromRecord(record) : undefined;
    });
  }

  ledgerAfter(walletId: string, afterVersion: number, limit: number) {
    return boundedTransaction(this.orm, this.options, async (em) => {
      const records = await em.find(
        LedgerEntrySchema,
        { walletId, walletVersion: { $gt: afterVersion } },
        { orderBy: { walletVersion: "asc" }, limit, disableIdentityMap: true },
      );
      return records.map(ledgerEntryFromRecord);
    });
  }
}
