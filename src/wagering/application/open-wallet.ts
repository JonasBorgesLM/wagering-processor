import type { Money } from "../domain/money";
import { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionProcessed, WalletBalanceChanged } from "../domain/wagering-events";
import { Wallet } from "../domain/wallet";
import type { Clock, IdGenerator, UnitOfWork } from "./ports";
import type { WalletView } from "./query-wallets";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

/**
 * Creates a wallet. A positive balance is funded by an internal `OPENING`
 * transaction and its ledger entry, in the same SQL transaction (FR-11), so the
 * ledger explains the balance from the first moment. A zero balance has nothing
 * to record (FR-12).
 *
 * Not idempotent: a second wallet for the same player and currency is a
 * conflict. The unique index decides it, so two creations racing give one
 * wallet and one conflict, never two wallets.
 */
export class OpenWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    const now = this.clock.now();
    const walletId = this.ids.next();
    const funded = command.initialBalance.isPositive();
    const opening = funded ? { transactionId: this.ids.next(), entryId: this.ids.next() } : undefined;

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      at: now,
      ...(opening ? { opening } : {}),
    });

    await this.unitOfWork.run(async (tx) => {
      // The wallet first: the transaction and the entry both point at it.
      await tx.wallets.insert(wallet);
      if (!openingEntry || !opening) return;

      const transaction = WagerTransaction.createOpening({
        id: opening.transactionId,
        walletId,
        playerId: command.playerId,
        money: command.initialBalance,
        createdAt: now,
      });
      transaction.markProcessed(undefined, wallet.balance, now);
      await tx.transactions.insert(transaction);
      await tx.ledger.append(openingEntry);

      const context = () => ({
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        occurredAt: now,
      });
      await tx.outbox.enqueue([
        WagerTransactionProcessed.from(transaction, context()),
        WalletBalanceChanged.from(wallet, openingEntry, context()),
      ]);
    });

    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version };
  }
}
