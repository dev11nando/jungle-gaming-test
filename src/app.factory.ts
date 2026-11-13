import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { hostname } from 'node:os';
import { AppModule } from './app.module';
import { JsonLogger } from './modules/observability/json-logger';
import { correlationMiddleware } from './modules/wagering/http/correlation';
import { HttpErrorFilter } from './modules/wagering/http/http-error.filter';

export function createLogger(): JsonLogger {
  return new JsonLogger(process.env.LOG_LEVEL ?? 'log', {
    service: 'wagering',
    instanceId: process.env.INSTANCE_ID ?? `${hostname()}:${process.pid}`,
  });
}

export function configureApp(app: INestApplication): INestApplication {
  app.use(json({ limit: '64kb' }));
  app.use(correlationMiddleware);
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableShutdownHooks();
  return app;
}

export async function createApp(): Promise<INestApplication> {
  const logger = createLogger();
  Logger.overrideLogger(logger);
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger });
  return configureApp(app);
}
