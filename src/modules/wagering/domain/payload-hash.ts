import { createHash } from 'node:crypto';
import type { MoneyProps } from './money';

/** Subconjunto de campos de negócio que entra no hash. Transporte e header ficam de fora. */
export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

/**
 * JSON canônico: chaves ordenadas por code point em todos os níveis, sem espaços,
 * campos `undefined` omitidos (nunca gravados como null).
 */
export function canonicalJson(value: Json | undefined): string {
  if (value === undefined) {
    throw new TypeError('cannot canonicalize undefined');
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** SHA-256 hex do JSON canônico do payload de negócio. `amount` já normalizado para escala 2. */
export function wagerPayloadHash(payload: WagerBusinessPayload): string {
  const business: WagerBusinessPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return sha256Hex(canonicalJson(business as unknown as Json));
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
