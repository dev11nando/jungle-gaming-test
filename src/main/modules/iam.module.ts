import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../../infra/config/app-config';
import { JWT_KEY_RESOLVER, remoteJwks } from '../../infra/auth/jwt-key-resolver';
import { OidcAuthGuard } from '../../infra/auth/oidc-auth.guard';
import { PROVIDER_IDENTITY } from '../../domain/contracts';
import { RequestProviderIdentity } from '../../infra/auth/request-provider-identity';
import { WhoAmIController } from '../../presentation/http/whoami.controller';

@Global()
@Module({
  controllers: [WhoAmIController],
  providers: [
    { provide: JWT_KEY_RESOLVER, inject: [APP_CONFIG], useFactory: (config: AppConfig) => remoteJwks(config) },
    { provide: APP_GUARD, useClass: OidcAuthGuard },
    { provide: PROVIDER_IDENTITY, useClass: RequestProviderIdentity },
  ],
  exports: [PROVIDER_IDENTITY],
})
export class IamModule {}
