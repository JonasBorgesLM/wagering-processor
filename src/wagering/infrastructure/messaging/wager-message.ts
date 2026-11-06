import type { SubmitWagerTransactionCommand } from "../../application/submit-wager-transaction";
import { exactObject, Issues, OPERATION_KEYS, parseOperation, parseText } from "../http/validation";

export const MESSAGE_TYPE = "WagerTransactionRequested";

/** The consumer's name in the inbox: one queue, one consumer, so a message id is unique within it (§10). */
export const CONSUMER_NAME = "wager-transactions";

/** A message that can never be processed, however often it is delivered: it goes to the dead-letter queue. */
export class UnprocessableMessageError extends Error {
  override readonly name = "UnprocessableMessageError";
}

export interface WagerMessage {
  messageId: string;
  command: SubmitWagerTransactionCommand;
}

/**
 * The queue message of §10, held to the rules of the HTTP request (SR-02): the fields are the same and so is the
 * code that checks them. The envelope adds `messageId` and `type`; `occurredAt` must be a date but is not used,
 * because the broker's clock and the provider's are no source of truth for ordering (NFR-05).
 */
export function parseWagerMessage(body: string | undefined): WagerMessage {
  let root: unknown;
  try {
    root = JSON.parse(body ?? "");
  } catch {
    throw new UnprocessableMessageError("the message body is not JSON");
  }
  if (typeof root === "object" && root !== null && !Array.isArray(root) && "type" in root) {
    if (root.type !== MESSAGE_TYPE) throw new UnprocessableMessageError("unknown message type");
  }

  const issues = new Issues();
  const envelope = exactObject(root, "", ["messageId", "type", "occurredAt", "data"], issues);
  const messageId =
    envelope && "messageId" in envelope ? parseText(envelope.messageId, "messageId", issues) : undefined;
  if (envelope && "occurredAt" in envelope) {
    const at = envelope.occurredAt;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) issues.add("occurredAt", "must be a date");
  }

  const data =
    envelope && "data" in envelope
      ? exactObject(envelope.data, "data", [...OPERATION_KEYS, "idempotencyKey"], issues, [
          "referenceExternalTransactionId",
        ])
      : undefined;
  const idempotencyKey =
    data && "idempotencyKey" in data
      ? parseText(data.idempotencyKey, "data.idempotencyKey", issues)
      : undefined;
  const operation = parseOperation(data, "data.", issues);
  issues.throwIfAny();

  return {
    messageId: messageId as string,
    command: {
      ...(operation as NonNullable<typeof operation>),
      idempotencyKey: idempotencyKey as string,
      correlationId: messageId as string,
      causationId: messageId as string,
    },
  };
}
