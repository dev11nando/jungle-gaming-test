import { InvalidTransactionStateError } from '../../../shared/domain/domain-error';
import type { IntegrationEvent } from '../../../shared/domain/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** Backoff de publicação: 1s · 2^n, teto de 5 minutos. A outbox nunca desiste: evento confirmado não se perde. */
export const OUTBOX_RETRY_POLICY = { baseDelayMs: 1_000, maxDelayMs: 5 * 60_000 } as const;

export class OutboxMessage {
  private constructor(
    /** = eventId do envelope. Estável entre republicações. */
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    // Garante que o payload é JSON puro (sem instâncias, sem undefined).
    const payload = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(payload),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt, s.attempts, s.nextAttemptAt, s.publishedAt);
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e agenda a próxima tentativa com backoff exponencial. */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + OutboxMessage.backoffMs(this._attempts));
  }

  static backoffMs(attempts: number): number {
    const exponent = Math.min(Math.max(attempts - 1, 0), 20);
    return Math.min(OUTBOX_RETRY_POLICY.maxDelayMs, OUTBOX_RETRY_POLICY.baseDelayMs * 2 ** exponent);
  }
}
