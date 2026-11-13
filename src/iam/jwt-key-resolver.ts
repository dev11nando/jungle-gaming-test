import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../config/app-config';

export const JWT_KEY_RESOLVER = Symbol('JWT_KEY_RESOLVER');

export type JwtKeyResolver = JWTVerifyGetKey;

export function remoteJwks(config: AppConfig): JwtKeyResolver {
  return createRemoteJWKSet(new URL(config.keycloak.jwksUri));
}
