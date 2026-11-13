import { Logger } from '@nestjs/common';
import { sleep } from './sqs';

export class PollingWorker {
  private readonly logger: Logger;
  private running = false;
  private loop?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(
    name: string,
    private readonly tick: () => Promise<number>,
    private readonly idleDelayMs: number,
  ) {
    this.logger = new Logger(name);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loop?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    while (this.running) {
      let handled = 0;
      try {
        handled = await this.tick();
      } catch (error) {
        this.logger.warn({ msg: 'worker cycle failed', error: error instanceof Error ? error.name : 'Error' });
      }
      if (handled === 0) await sleep(this.idleDelayMs, this.abort.signal);
    }
  }
}
