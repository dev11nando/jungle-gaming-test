import { existsSync, readFileSync } from 'node:fs';

export interface SqsConfig {
  endpoint: string;
  region: string;
  queueName: string;
}

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
    },
    keycloak: {
      issuer: required(env, 'KEYCLOAK_ISSUER'),
      jwksUri: required(env, 'KEYCLOAK_JWKS_URI'),
      audience: required(env, 'KEYCLOAK_AUDIENCE'),
      healthUrl: required(env, 'KEYCLOAK_HEALTH_URL'),
    },
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value.trim();
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
