import 'reflect-metadata';
import { createApp } from './main/app.factory';
import { loadAppConfig } from './infra/config/app-config';

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  const app = await createApp();
  if (config.httpEnabled) {
    await app.listen(config.port);
  } else {
    await app.init();
  }
}

void bootstrap();
