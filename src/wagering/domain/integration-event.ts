import { InvalidIntegrationEventError } from "./errors";
import { assertDate, assertText } from "./guards";

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
  data: T;
}

/** What the caller knows about the moment an event describes. The domain mints no ids and reads no clock. */
export interface EventContext {
  eventId: string;
  /** Ties together everything one request or message caused, across events and log lines. */
  correlationId: string;
  /** The message or request that directly caused this event. */
  causationId?: string | undefined;
  occurredAt: Date;
}

/** The serialized envelope, which is what the outbox stores and the broker carries. */
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * A fact other systems may act on, published through the outbox after commit.
 *
 * `eventType` and `version` belong to the type, not to the call site, so a
 * payload cannot be emitted under the wrong name or version. `data` holds only
 * plain JSON (money as `MoneyProps`, never a `Money`): the payload is a contract
 * with consumers, and a bigint or a class instance in it would not survive
 * serialization or a version change.
 *
 * Delivery is at least once, so a consumer may see an event twice and should
 * deduplicate by `eventId` (IR-03).
 */
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: Readonly<T>;
  private readonly _occurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    assertText(props.eventId, "eventId", InvalidIntegrationEventError);
    assertText(props.aggregateId, "aggregateId", InvalidIntegrationEventError);
    assertText(props.correlationId, "correlationId", InvalidIntegrationEventError);
    assertDate(props.occurredAt, "occurredAt", InvalidIntegrationEventError);
    if (props.causationId !== undefined) {
      assertText(props.causationId, "causationId", InvalidIntegrationEventError);
      this.causationId = props.causationId;
    }
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this._occurredAt = new Date(props.occurredAt);
    this.data = deepFreeze(props.data);
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

/** `data` is plain JSON, so a recursive freeze is enough to make the payload unchangeable after the event exists. */
function deepFreeze<T extends object>(value: T): T {
  for (const member of Object.values(value)) {
    if (typeof member === "object" && member !== null) deepFreeze(member);
  }
  return Object.freeze(value);
}
