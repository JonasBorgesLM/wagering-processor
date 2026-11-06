import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { QueryTransactions } from "../../application/query-transactions";
import { SubmitWagerTransaction } from "../../application/submit-wager-transaction";
import type { CorrelatedRequest } from "./correlation";
import { ProviderAuthGuard } from "./provider-auth.guard";
import { submissionReply, transactionBody } from "./transaction-replies";
import { parseProviderTransactionPath, parseSubmitTransaction, parseTransactionId } from "./validation";

interface StatusSetter {
  status(code: number): unknown;
}

// Thin on purpose: parse, call one use case, shape the answer.
@UseGuards(ProviderAuthGuard)
@Controller()
export class TransactionsController {
  private readonly logger = new Logger(TransactionsController.name);

  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(QueryTransactions) private readonly queries: QueryTransactions,
  ) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: unknown,
    @Req() request: CorrelatedRequest,
    @Res({ passthrough: true }) response: StatusSetter,
  ) {
    const parsed = parseSubmitTransaction(headers, body);
    const correlationId = request.correlationId ?? randomUUID();
    const started = performance.now();
    const result = await this.submit.execute({
      ...parsed,
      correlationId,
      // What directly caused the events: this request, identified by the key the provider chose for it.
      causationId: parsed.idempotencyKey,
    });
    // The fields that tie this line to the request, the transaction and the wallet. Never the amount, the player, the
    // round or the key: those are the payload (SR-01).
    this.logger.log(result.idempotentReplay ? "Transaction replayed" : "Transaction decided", {
      correlationId,
      transactionId: result.transactionId,
      walletId: parsed.walletId,
      providerId: parsed.providerId,
      status: result.status,
      failureCode: result.failureCode,
      durationMs: Math.round(performance.now() - started), // money-check: not-money a duration in milliseconds
    });
    const reply = submissionReply(result);
    response.status(reply.status);
    return reply.body;
  }

  @Get("wagering/transactions/:transactionId")
  async byId(@Param("transactionId") transactionId: string) {
    return transactionBody(await this.queries.getById(parseTransactionId(transactionId)));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async byExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const path = parseProviderTransactionPath(providerId, externalTransactionId);
    return transactionBody(await this.queries.getByExternalId(path.providerId, path.externalTransactionId));
  }
}
