import { Logger as NestLogger } from '@nestjs/common';
import type { LogEntry, Logger } from '../../domain/contracts';

export function nestLogger(context: string): Logger {
  const logger = new NestLogger(context);
  return {
    info: (entry: LogEntry) => logger.log(entry),
    warn: (entry: LogEntry) => logger.warn(entry),
    error: (entry: LogEntry) => logger.error(entry),
  };
}
