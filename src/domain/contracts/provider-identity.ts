export interface ProviderIdentity {
  subject: string;
  clientId: string;
  providerId: string;
}

export interface ProviderIdentityPort {
  current(): ProviderIdentity | undefined;
}

export const PROVIDER_IDENTITY = Symbol('ProviderIdentityPort');
