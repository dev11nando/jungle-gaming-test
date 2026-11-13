import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { configureApp } from '../../src/app.factory';
import { AppModule } from '../../src/app.module';
import { JWT_KEY_RESOLVER } from '../../src/iam/jwt-key-resolver';
import { TEST_DATABASE_URL } from './database';

export const ISSUER = 'http://localhost:8080/realms/jungle';
export const AUDIENCE = 'wagering-api';

type Key = CryptoKey | KeyObject;

export interface TestHttpApp {
  app: INestApplication;
  baseUrl: string;
  token: (claims?: Record<string, unknown>, opts?: { audience?: string; issuer?: string }) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Sobe a aplicação real (todos os módulos, PostgreSQL real), trocando apenas a origem
 * das chaves JWT: tokens são assinados por um par RSA local em vez do Keycloak.
 */
export async function startHttpApp(overrides: { provide: unknown; useValue: unknown }[] = []): Promise<TestHttpApp> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(JWT_KEY_RESOLVER)
    .useValue(async () => publicKey as Key);
  for (const o of overrides) {
    builder = builder.overrideProvider(o.provide as symbol).useValue(o.useValue);
  }
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication({ bodyParser: false }));
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: (claims = { provider_id: 'provider-a' }, opts = {}) =>
      new SignJWT({ azp: 'provider-a', ...claims })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('service-account-provider-a')
        .setIssuer(opts.issuer ?? ISSUER)
        .setAudience(opts.audience ?? AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey as Key),
    close: () => app.close(),
  };
}
