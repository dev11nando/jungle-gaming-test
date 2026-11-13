import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { JWT_KEY_RESOLVER, remoteJwks } from './jwt-key-resolver';
import { OidcAuthGuard } from './oidc-auth.guard';
import { ProviderIdentityPort } from './provider-identity';
import { RequestProviderIdentity } from './request-provider-identity';
import { WhoAmIController } from './whoami.controller';

@Global()
@Module({
  controllers: [WhoAmIController],
  providers: [
    { provide: JWT_KEY_RESOLVER, inject: [APP_CONFIG], useFactory: (config: AppConfig) => remoteJwks(config) },
    { provide: APP_GUARD, useClass: OidcAuthGuard },
    { provide: ProviderIdentityPort, useClass: RequestProviderIdentity },
  ],
  exports: [ProviderIdentityPort],
})
export class IamModule {}
