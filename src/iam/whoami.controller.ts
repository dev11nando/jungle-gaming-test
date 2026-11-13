import { Controller, Get, Inject, UnauthorizedException } from '@nestjs/common';
import { ProviderIdentity, ProviderIdentityPort } from './provider-identity';

@Controller()
export class WhoAmIController {
  constructor(@Inject(ProviderIdentityPort) private readonly identity: ProviderIdentityPort) {}

  @Get('whoami')
  whoami(): ProviderIdentity {
    const current = this.identity.current();
    if (current === undefined) {
      throw new UnauthorizedException('missing_identity');
    }
    return current;
  }
}
