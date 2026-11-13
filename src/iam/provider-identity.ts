import { ForbiddenException } from '@nestjs/common';

export interface ProviderIdentity {
  subject: string;
  clientId: string;
  providerId: string;
}

export interface RequestWithIdentity {
  headers: { authorization?: string | string[] };
  identity?: ProviderIdentity;
}

/**
 * Porta de leitura da identidade do request.
 * A fila, quando passar a carregar identidade assinada, ganha outro adapter
 * atrás desta mesma porta. O caso de uso não conhece JWT.
 */
export abstract class ProviderIdentityPort {
  abstract current(): ProviderIdentity | undefined;
}

export function assertSameProvider(identity: ProviderIdentity, providerId: string): void {
  if (identity.providerId !== providerId) {
    throw new ForbiddenException('provider_mismatch');
  }
}
