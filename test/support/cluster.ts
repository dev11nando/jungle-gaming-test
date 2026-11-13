import type { Subprocess } from 'bun';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { AUDIENCE, ISSUER } from './http-app';
import { SQS_ENDPOINT, type TestQueues } from './sqs';

type Key = CryptoKey | KeyObject;

/** JWKS servido localmente: os processos reais validam tokens pelo mesmo caminho de produção. */
export async function startJwksServer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey as Key)), kid: 'cluster-test', alg: 'RS256', use: 'sig' };
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  return {
    url: `http://127.0.0.1:${server.port}/certs`,
    token: (providerId = 'provider-a') =>
      new SignJWT({ provider_id: providerId, azp: providerId })
        .setProtectedHeader({ alg: 'RS256', kid: 'cluster-test' })
        .setSubject(`service-account-${providerId}`)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey as Key),
    stop: () => server.stop(true),
  };
}

export interface NodeOptions {
  id: string;
  port: number;
  databaseUrl: string;
  jwksUri: string;
  queues: TestQueues;
}

export class ClusterNode {
  private proc?: Subprocess;

  constructor(readonly options: NodeOptions) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  async start(): Promise<void> {
    const o = this.options;
    this.proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(o.port),
        DATABASE_URL: o.databaseUrl,
        SQS_ENDPOINT,
        SQS_REGION: 'us-east-1',
        SQS_QUEUE_NAME: o.queues.queueName,
        SQS_DLQ_NAME: o.queues.dlqName,
        SQS_EVENTS_QUEUE_NAME: o.queues.eventsQueueName,
        SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
        SQS_WAIT_TIME_SECONDS: '1',
        KEYCLOAK_ISSUER: ISSUER,
        KEYCLOAK_JWKS_URI: o.jwksUri,
        KEYCLOAK_AUDIENCE: AUDIENCE,
        KEYCLOAK_HEALTH_URL: o.jwksUri,
        WORKERS: 'consumer,outbox,pending-reference',
        INSTANCE_ID: o.id,
        LOG_LEVEL: process.env.CLUSTER_LOG_LEVEL ?? 'error',
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await this.waitReady();
  }

  /** Morte abrupta (SIGKILL): sem shutdown hooks, sem ack, sem marcar outbox. */
  async kill(): Promise<void> {
    this.proc?.kill('SIGKILL');
    await this.proc?.exited;
    this.proc = undefined;
  }

  async stop(): Promise<void> {
    if (this.proc === undefined) return;
    this.proc.kill('SIGTERM');
    await Promise.race([this.proc.exited, Bun.sleep(15_000)]);
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    this.proc = undefined;
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/health/ready`);
        if (res.status === 200) return;
      } catch {
        // ainda subindo
      }
      await Bun.sleep(200);
    }
    throw new Error(`node ${this.options.id} not ready`);
  }
}

export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port ?? 0;
  server.stop(true);
  return port;
}
