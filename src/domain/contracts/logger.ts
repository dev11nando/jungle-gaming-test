export type LogEntry = { msg: string } & Record<string, unknown>;

export interface Logger {
  info(entry: LogEntry): void;
  warn(entry: LogEntry): void;
  error(entry: LogEntry): void;
}
