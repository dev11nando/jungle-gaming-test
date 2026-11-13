import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { OidcAuthGuard } from './oidc-auth.guard';
import { ProviderIdentityPort } from './provider-identity';
import { RequestProviderIdentity } from './request-provider-identity';
import { WhoAmIController } from './whoami.controller';

@Module({
  controllers: [WhoAmIController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: OidcAuthGuard,
    },
    {
      provide: ProviderIdentityPort,
      useClass: RequestProviderIdentity,
    },
  ],
})
export class IamModule {}