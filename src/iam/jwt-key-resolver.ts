import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../config/app-config';

/**
 * Resolve as chaves de verificação do JWT. Em produção, JWKS remoto do Keycloak (com cache do jose).
 * Testes substituem por uma chave local, sem precisar do IdP no ar.
 */
export const JWT_KEY_RESOLVER = Symbol('JWT_KEY_RESOLVER');

export type JwtKeyResolver = JWTVerifyGetKey;

export function remoteJwks(config: AppConfig): JwtKeyResolver {
  return createRemoteJWKSet(new URL(config.keycloak.jwksUri));
}
