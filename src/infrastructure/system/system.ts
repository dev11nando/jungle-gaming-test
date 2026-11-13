import { randomBytes } from 'node:crypto';
import { Clock, IdGenerator } from '../../modules/wagering/application/ports';

/**
 * UUIDv7 (RFC 9562): 48 bits de timestamp em ms + aleatório. Ordenável no tempo,
 * o que mantém índices de PK compactos e ajuda leitura de logs.
 */
export function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class UuidV7Generator extends IdGenerator {
  next(): string {
    return uuidV7();
  }
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
