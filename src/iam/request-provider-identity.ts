import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ProviderIdentity, ProviderIdentityPort, RequestWithIdentity } from './provider-identity';

@Injectable({ scope: Scope.REQUEST })
export class RequestProviderIdentity extends ProviderIdentityPort {
  constructor(@Inject(REQUEST) private readonly request: RequestWithIdentity) {
    super();
  }

  current(): ProviderIdentity | undefined {
    return this.request.identity;
  }
}
