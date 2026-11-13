export interface ProviderIdentity {
  subject: string;
  clientId: string;
  providerId: string;
}

export interface RequestWithIdentity {
  headers: { authorization?: string | string[] };
  identity?: ProviderIdentity;
}

export abstract class ProviderIdentityPort {
  abstract current(): ProviderIdentity | undefined;
}
