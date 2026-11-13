import { Logger } from '@nestjs/common';
import { METRIC, Metrics } from '../../../shared/application/metrics';
import { InvalidInputError } from '../../../shared/domain/domain-error';
import { ConflictError, NotFoundError } from '../../wagering/application/errors';
import type { UnitOfWork } from '../../wagering/application/ports';
import type { SubmitWagerTransaction } from '../../wagering/application/submit-wager-transaction';
import { parseSubmitWagerCommand } from '../../wagering/application/wager-command';
import { canonicalJson, sha256Hex } from '../../wagering/domain/payload-hash';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';
export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export type HandleOutcome =
  | { action: 'ack'; reason: 'processed' | 'duplicate_message' | 'replay'; transactionId?: string; status?: string }
  | { action: 'retry'; reason: string }
  | { action: 'dead-letter'; reason: string };

interface Envelope {
  messageId: string;
  type: string;
  correlationId?: string;
  data: Record<string, unknown>;
}

export class WagerMessageHandler {
  private readonly logger = new Logger(WagerMessageHandler.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly submit: SubmitWagerTransaction,
    private readonly metrics: Metrics,
    private readonly maxAttempts: number,
    private readonly consumerName = WAGER_CONSUMER_NAME,
  ) {}

  async handle(body: string | undefined, receiveCount: number): Promise<HandleOutcome> {
    const outcome = await this.classify(body, receiveCount);
    this.metrics.increment(METRIC.sqsMessages, { action: outcome.action, reason: outcome.reason });
    return outcome;
  }

  private async classify(body: string | undefined, receiveCount: number): Promise<HandleOutcome> {
    const envelope = parseEnvelope(body);
    if ('error' in envelope) return { action: 'dead-letter', reason: envelope.error };

    const log = { messageId: envelope.messageId, correlationId: envelope.correlationId ?? envelope.messageId };
    const payloadHash = sha256Hex(canonicalJson(envelope.data as never));

    try {
      const seen = await this.uow.read((r) => r.inbox.find(this.consumerName, envelope.messageId));
      if (seen !== undefined) {
        if (!seen.matchesPayload(payloadHash)) {
          this.logger.warn({ msg: 'messageId reused with different payload', ...log });
          return { action: 'dead-letter', reason: 'MESSAGE_ID_CONFLICT' };
        }
        this.metrics.increment(METRIC.duplicatesDetected, { source: 'inbox' });
        return { action: 'ack', reason: 'duplicate_message' };
      }

      const command = parseSubmitWagerCommand(envelope.data, envelope.data.idempotencyKey);
      const result = await this.submit.execute(command, {
        correlationId: log.correlationId,
        causationId: envelope.messageId,
        inbox: { consumerName: this.consumerName, messageId: envelope.messageId, payloadHash },
      });
      return {
        action: 'ack',
        reason: result.idempotentReplay ? 'replay' : 'processed',
        transactionId: result.transaction.id,
        status: result.transaction.status,
      };
    } catch (error) {
      if (error instanceof InvalidInputError || error instanceof NotFoundError || error instanceof ConflictError) {
        this.logger.warn({ msg: 'permanent message failure', code: error.code, ...log });
        return { action: 'dead-letter', reason: error.code };
      }
      const reason = error instanceof Error ? error.name : 'UnknownError';
      if (receiveCount >= this.maxAttempts) {
        this.logger.error({ msg: 'message exhausted attempts', reason, receiveCount, ...log });
        return { action: 'dead-letter', reason: 'MAX_ATTEMPTS_EXCEEDED' };
      }
      this.metrics.increment(METRIC.retries, { reason: 'sqs_transient' });
      this.logger.warn({ msg: 'transient message failure', reason, attempt: receiveCount, ...log });
      return { action: 'retry', reason };
    }
  }
}

function parseEnvelope(body: string | undefined): Envelope | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? '');
  } catch {
    return { error: 'INVALID_JSON' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'INVALID_ENVELOPE' };
  const env = raw as Record<string, unknown>;
  if (typeof env.messageId !== 'string' || env.messageId.trim() === '' || env.messageId.length > 256) {
    return { error: 'INVALID_ENVELOPE' };
  }
  if (env.type !== WAGER_MESSAGE_TYPE) return { error: 'UNSUPPORTED_MESSAGE_TYPE' };
  if (env.data === null || typeof env.data !== 'object' || Array.isArray(env.data)) return { error: 'INVALID_ENVELOPE' };
  return {
    messageId: env.messageId,
    type: env.type,
    correlationId: typeof env.correlationId === 'string' && env.correlationId.length <= 128 ? env.correlationId : undefined,
    data: env.data as Record<string, unknown>,
  };
}

/** Backoff de visibilidade para retry: 2^n segundos, teto de 60s. */
export function retryVisibilitySeconds(receiveCount: number): number {
  return Math.min(60, 2 ** Math.max(1, receiveCount));
}
