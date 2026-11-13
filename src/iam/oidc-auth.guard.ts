import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ProviderIdentity, RequestWithIdentity } from './provider-identity';

@Injectable()
export class OidcAuthGuard implements CanActivate {
  private readonly jwks: JWTVerifyGetKey;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.jwks = createRemoteJWKSet(new URL(config.keycloak.jwksUri));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) {
      throw new UnauthorizedException('missing_bearer_token');
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.jwks, {
        issuer: this.config.keycloak.issuer,
        audience: this.config.keycloak.audience,
        clockTolerance: 5,
      });
      payload = verified.payload;
    } catch {
      throw new UnauthorizedException('invalid_token');
    }

    const providerId = readStringClaim(payload, 'provider_id');
    const subject = readStringClaim(payload, 'sub');
    if (providerId === undefined || subject === undefined) {
      throw new ForbiddenException('missing_provider_id');
    }

    const identity: ProviderIdentity = {
      subject,
      clientId: readStringClaim(payload, 'azp') ?? '',
      providerId,
    };
    request.identity = identity;
    return true;
  }
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !value.startsWith('Bearer ')) {
    return undefined;
  }
  const token = value.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

function readStringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
