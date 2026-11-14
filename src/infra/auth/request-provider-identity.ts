import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { ProviderIdentity, ProviderIdentityPort } from '../../domain/contracts';
import type { RequestWithIdentity } from './provider-identity';

@Injectable({ scope: Scope.REQUEST })
export class RequestProviderIdentity implements ProviderIdentityPort {
  constructor(@Inject(REQUEST) private readonly request: RequestWithIdentity) {}

  current(): ProviderIdentity | undefined {
    return this.request.identity;
  }
}
