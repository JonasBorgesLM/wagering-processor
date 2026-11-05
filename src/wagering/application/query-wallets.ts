import type { Money } from "../domain/money";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { InvalidRequestError, WalletNotFoundError } from "./errors";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";
import type { WalletReader } from "./ports";

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Absent on the last page. */
  nextCursor: string | undefined;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
}

export class QueryWallets {
  constructor(private readonly reader: WalletReader) {}

  async getWallet(id: string): Promise<WalletView> {
    return viewOf(await this.requireWallet(id));
  }

  async getLedger(
    walletId: string,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<LedgerPage> {
    const limit = query.limit ?? DEFAULT_LEDGER_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
      throw new InvalidRequestError([
        { field: "limit", reason: `must be a whole number from 1 to ${MAX_LEDGER_LIMIT}` },
      ]);
    }
    const after = query.cursor === undefined ? 0 : decodeLedgerCursor(query.cursor);
    await this.requireWallet(walletId);

    // One more than asked for, to learn whether there is a next page without a second query.
    const found = await this.reader.ledgerAfter(walletId, after, limit + 1);
    const entries = found.slice(0, limit);
    const last = entries.at(-1);
    return {
      entries,
      nextCursor: found.length > limit && last ? encodeLedgerCursor(last.walletVersion) : undefined,
    };
  }

  private async requireWallet(id: string): Promise<Wallet> {
    const wallet = await this.reader.findWallet(id);
    if (!wallet) throw new WalletNotFoundError(`wallet ${id} does not exist`);
    return wallet;
  }
}

function viewOf(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version };
}
