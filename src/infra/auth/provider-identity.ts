import type { ProviderIdentity } from '../../domain/contracts';

export interface RequestWithIdentity {
  headers: { authorization?: string | string[] };
  identity?: ProviderIdentity;
}
