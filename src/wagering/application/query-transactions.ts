import type { WagerTransaction } from "../domain/wager-transaction";
import { TransactionNotFoundError } from "./errors";
import type { TransactionReader } from "./ports";

/** Looks a transaction up by our id, or by the provider's own. Reads only, and never takes a lock. */
export class QueryTransactions {
  constructor(private readonly reader: TransactionReader) {}

  async getById(id: string): Promise<WagerTransaction> {
    const found = await this.reader.findById(id);
    if (!found) throw new TransactionNotFoundError(`transaction ${id} does not exist`);
    return found;
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const found = await this.reader.findByExternalId(providerId, externalTransactionId);
    if (!found) throw new TransactionNotFoundError(`${providerId}:${externalTransactionId} does not exist`);
    return found;
  }
}
