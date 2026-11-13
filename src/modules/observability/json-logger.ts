import type { LoggerService, LogLevel } from '@nestjs/common';

const LEVELS: Record<string, number> = { fatal: 0, error: 1, warn: 2, log: 3, info: 3, debug: 4, verbose: 5 };

// Campos fora da lista são descartados, para não vazar payload financeiro ou token.
const ALLOWED_FIELDS = new Set([
  'msg',
  'correlationId',
  'causationId',
  'messageId',
  'transactionId',
  'walletId',
  'providerId',
  'eventId',
  'eventType',
  'kind',
  'status',
  'failureCode',
  'idempotentReplay',
  'code',
  'reason',
  'path',
  'error',
  'detail',
  'attempt',
  'receiveCount',
  'count',
  'difference',
  'checkedEntries',
  'durationMs',
  'queue',
  'workerId',
  'lagSeconds',
  'instanceId',
]);

export class JsonLogger implements LoggerService {
  private readonly threshold: number;

  constructor(
    level: string = process.env.LOG_LEVEL ?? 'log',
    private readonly base: Record<string, string> = {},
  ) {
    this.threshold = level === 'silent' ? -1 : (LEVELS[level] ?? 3);
  }

  log(message: unknown, context?: string): void {
    this.write('info', 3, message, context);
  }
  error(message: unknown, stackOrContext?: string, context?: string): void {
    this.write('error', 1, message, context ?? stackOrContext);
  }
  warn(message: unknown, context?: string): void {
    this.write('warn', 2, message, context);
  }
  debug(message: unknown, context?: string): void {
    this.write('debug', 4, message, context);
  }
  verbose(message: unknown, context?: string): void {
    this.write('verbose', 5, message, context);
  }
  fatal(message: unknown, context?: string): void {
    this.write('fatal', 0, message, context);
  }
  setLogLevels(_levels: LogLevel[]): void {}

  private write(level: string, weight: number, message: unknown, context?: string): void {
    if (weight > this.threshold) return;
    const entry: Record<string, unknown> = { time: new Date().toISOString(), level, ...this.base };
    if (context !== undefined) entry.context = context;
    if (message !== null && typeof message === 'object' && !(message instanceof Error)) {
      for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
        if (value !== undefined && ALLOWED_FIELDS.has(key)) entry[key] = value;
      }
    } else if (message instanceof Error) {
      entry.msg = message.message;
      entry.error = message.name;
    } else {
      entry.msg = String(message);
    }
    const line = JSON.stringify(entry);
    if (weight <= 1) process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}
