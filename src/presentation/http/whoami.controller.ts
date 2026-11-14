import { Controller, Get, Inject, UnauthorizedException } from '@nestjs/common';
import { PROVIDER_IDENTITY, type ProviderIdentity, type ProviderIdentityPort } from '../../domain/contracts';

@Controller()
export class WhoAmIController {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  @Get('whoami')
  whoami(): ProviderIdentity {
    const current = this.identity.current();
    if (current === undefined) {
      throw new UnauthorizedException('missing_identity');
    }
    return current;
  }
}
