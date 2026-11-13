import { existsSync, readFileSync } from 'node:fs';

export interface SqsConfig {
  endpoint: string;
  region: string;
  queueName: string;
  dlqName: string;
  eventsQueueName: string;
  maxReceiveCount: number;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds: number;
}

export type WorkerName = 'consumer' | 'outbox' | 'pending-reference';

export interface KeycloakConfig {
  issuer: string;
  jwksUri: string;
  audience: string;
  healthUrl: string;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  sqs: SqsConfig;
  keycloak: KeycloakConfig;
  workers: ReadonlySet<WorkerName>;
  httpEnabled: boolean;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadDotEnvFile();
  return {
    port: parsePort(required(env, 'PORT')),
    databaseUrl: required(env, 'DATABASE_URL'),
    sqs: {
      endpoint: required(env, 'SQS_ENDPOINT'),
      region: required(env, 'SQS_REGION'),
      queueName: required(env, 'SQS_QUEUE_NAME'),
      dlqName: optional(env, 'SQS_DLQ_NAME', 'wager-transactions-dlq.fifo'),
      eventsQueueName: optional(env, 'SQS_EVENTS_QUEUE_NAME', 'wager-events.fifo'),
      maxReceiveCount: parseIntIn(optional(env, 'SQS_MAX_RECEIVE_COUNT', '5'), 1, 1000, 'SQS_MAX_RECEIVE_COUNT'),
      visibilityTimeoutSeconds: parseIntIn(optional(env, 'SQS_VISIBILITY_TIMEOUT_SECONDS', '30'), 1, 43200, 'SQS_VISIBILITY_TIMEOUT_SECONDS'),
      waitTimeSeconds: parseIntIn(optional(env, 'SQS_WAIT_TIME_SECONDS', '10'), 0, 20, 'SQS_WAIT_TIME_SECONDS'),
    },
    keycloak: {
      issuer: required(env, 'KEYCLOAK_ISSUER'),
      jwksUri: required(env, 'KEYCLOAK_JWKS_URI'),
      audience: required(env, 'KEYCLOAK_AUDIENCE'),
      healthUrl: required(env, 'KEYCLOAK_HEALTH_URL'),
    },
    workers: parseWorkers(optional(env, 'WORKERS', 'consumer,outbox,pending-reference')),
    httpEnabled: optional(env, 'HTTP_ENABLED', 'true') !== 'false',
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value.trim();
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function parseIntIn(value: string, min: number, max: number, name: string): number {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return Number(value);
}

function parseWorkers(value: string): ReadonlySet<WorkerName> {
  if (value === 'none') return new Set();
  const allowed: WorkerName[] = ['consumer', 'outbox', 'pending-reference'];
  const names = value.split(',').map((n) => n.trim()).filter(Boolean);
  for (const n of names) {
    if (!allowed.includes(n as WorkerName)) throw new Error(`Invalid WORKERS entry: ${n}`);
  }
  return new Set(names as WorkerName[]);
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function loadDotEnvFile(): void {
  if (!existsSync('.env')) {
    return;
  }
  const text = readFileSync('.env', 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
