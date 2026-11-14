import { InvalidInputError } from '../errors/domain-error';
import { Money, type MoneyProps } from '../entities/money';
import { wagerPayloadHash } from '../services/payload-hash';
import { INTERNAL_PROVIDER_ID } from '../entities/wager-transaction';
import { SUBMITTABLE_KINDS, WagerTransactionKind } from '../entities/wagering-types';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  payloadHash: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new InvalidInputError('INVALID_FIELD', `${field} must be a UUID`);
  }
  return value.toLowerCase();
}

export function requireString(source: Record<string, unknown>, field: string, maxLength: number): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw new InvalidInputError('INVALID_FIELD', `${field} must be a non-empty string without surrounding spaces`);
  }
  if (value.length > maxLength) {
    throw new InvalidInputError('INVALID_FIELD', `${field} exceeds ${maxLength} characters`);
  }
  return value;
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidInputError('INVALID_FIELD', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseMoney(value: unknown, field = 'money'): Money {
  const obj = requireObject(value, field);
  return Money.from({ amount: obj.amount as string, currency: obj.currency as string });
}

export function parseSubmitWagerCommand(body: unknown, idempotencyKeyHeader: unknown): SubmitWagerCommand {
  if (typeof idempotencyKeyHeader !== 'string' || idempotencyKeyHeader.trim() === '') {
    throw new InvalidInputError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
  }
  if (idempotencyKeyHeader.length > 512) {
    throw new InvalidInputError('INVALID_FIELD', 'Idempotency-Key exceeds 512 characters');
  }
  const src = requireObject(body, 'body');
  const providerId = requireString(src, 'providerId', 128);
  if (providerId === INTERNAL_PROVIDER_ID) {
    throw new InvalidInputError('INVALID_FIELD', `providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
  }
  const externalTransactionId = requireString(src, 'externalTransactionId', 256);
  const playerId = requireString(src, 'playerId', 128);
  const walletId = requireUuid(src.walletId, 'walletId');
  const roundId = requireString(src, 'roundId', 256);
  const gameId = requireString(src, 'gameId', 256);

  const kind = src.kind;
  if (kind === WagerTransactionKind.Opening) {
    throw new InvalidInputError('OPENING_NOT_SUBMITTABLE', 'OPENING is internal and cannot be submitted');
  }
  if (typeof kind !== 'string' || !SUBMITTABLE_KINDS.includes(kind as WagerTransactionKind)) {
    throw new InvalidInputError('INVALID_KIND', `kind must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
  }
  const money = parseMoney(src.money);

  let referenceExternalTransactionId: string | undefined;
  if (src.referenceExternalTransactionId !== undefined && src.referenceExternalTransactionId !== null) {
    referenceExternalTransactionId = requireString(src, 'referenceExternalTransactionId', 256);
  }
  const typedKind = kind as WagerTransactionKind;
  if ((typedKind === WagerTransactionKind.Refund || typedKind === WagerTransactionKind.Rollback) && !referenceExternalTransactionId) {
    throw new InvalidInputError('REFERENCE_REQUIRED', `${kind} requires referenceExternalTransactionId`);
  }

  const moneyProps: MoneyProps = money.toJSON();
  const payloadHash = wagerPayloadHash({
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind: typedKind,
    money: moneyProps,
    referenceExternalTransactionId,
  });

  return {
    idempotencyKey: idempotencyKeyHeader,
    payloadHash,
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind: typedKind,
    money,
    referenceExternalTransactionId,
  };
}
