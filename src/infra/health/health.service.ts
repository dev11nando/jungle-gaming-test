import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export type CheckStatus = 'up' | 'down';

export interface ReadyReport {
  status: 'ok' | 'down';
  checks: {
    postgres: CheckStatus;
    sqs: CheckStatus;
    keycloak: CheckStatus;
  };
}

const CHECK_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private readonly pool: Pool;
  private readonly sqs: SQSClient;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: CHECK_TIMEOUT_MS,
      max: 2,
    });
    this.sqs = new SQSClient({
      region: config.sqs.region,
      endpoint: config.sqs.endpoint,
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });
  }

  async ready(): Promise<ReadyReport> {
    const [postgres, sqs, keycloak] = await Promise.all([
      this.checkPostgres(),
      this.checkSqs(),
      this.checkKeycloak(),
    ]);
    const checks = { postgres, sqs, keycloak };
    // Keycloak não entra: o JWKS em cache segue validando tokens e a fila não depende do IdP.
    const status = postgres === 'up' && sqs === 'up' ? 'ok' : 'down';
    return { status, checks };
  }

  async onModuleDestroy(): Promise<void> {
    this.sqs.destroy();
    await this.pool.end();
  }

  private async checkPostgres(): Promise<CheckStatus> {
    try {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
      return 'up';
    } catch (error) {
      this.logger.warn(`postgres unreachable: ${errorName(error)}`);
      return 'down';
    }
  }

  private async checkSqs(): Promise<CheckStatus> {
    try {
      await withTimeout(
        this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.queueName })),
        CHECK_TIMEOUT_MS,
      );
      return 'up';
    } catch (error) {
      this.logger.warn(`sqs unreachable: ${errorName(error)}`);
      return 'down';
    }
  }

  private async checkKeycloak(): Promise<CheckStatus> {
    try {
      const response = await fetch(this.config.keycloak.healthUrl, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      return response.ok ? 'up' : 'down';
    } catch (error) {
      this.logger.warn(`keycloak unreachable: ${errorName(error)}`);
      return 'down';
    }
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
