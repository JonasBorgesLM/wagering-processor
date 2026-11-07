import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { OpenWallet } from "../../application/open-wallet";
import { QueryWallets, type WalletView } from "../../application/query-wallets";
import { ReconcileWallet } from "../../application/reconcile-wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { CorrelatedRequest } from "./correlation";
import { ProviderAuthGuard } from "./provider-auth.guard";
import { parseLedgerQuery, parseOpenWalletBody, parseWalletId } from "./validation";

// Thin on purpose: parse, call one use case, shape the answer. Nothing a rule depends on lives here.

function walletBody(wallet: WalletView) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

function entryBody(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

@UseGuards(ProviderAuthGuard)
@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(QueryWallets) private readonly queries: QueryWallets,
    @Inject(ReconcileWallet) private readonly reconciliation: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() request: CorrelatedRequest) {
    const { playerId, initialBalance } = parseOpenWalletBody(body);
    const wallet = await this.openWallet.execute({
      playerId,
      initialBalance,
      correlationId: request.correlationId ?? randomUUID(),
    });
    return walletBody(wallet);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    return walletBody(await this.queries.getWallet(parseWalletId(walletId)));
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query() query: unknown) {
    const page = await this.queries.getLedger(parseWalletId(walletId), parseLedgerQuery(query));
    return { items: page.entries.map(entryBody), nextCursor: page.nextCursor ?? null };
  }

  /**
   * A POST because the challenge names it so, and because it is a check being run and not a resource being read.
   * It changes nothing (FR-72), and so it is safe to repeat.
   */
  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string) {
    const report = await this.reconciliation.execute(parseWalletId(walletId));
    return {
      walletId: report.walletId,
      storedBalance: report.storedBalance.toJSON(),
      calculatedBalance: report.calculatedBalance.toJSON(),
      difference: report.difference.toJSON(),
      consistent: report.consistent,
      checkedEntries: report.checkedEntries,
      issueCount: report.issueCount,
      issues: report.issues,
    };
  }
}
