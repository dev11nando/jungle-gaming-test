import 'reflect-metadata';
import { createApp } from './app.factory';
import { loadAppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  const app = await createApp();
  await app.listen(config.port);
}

void bootstrap();
