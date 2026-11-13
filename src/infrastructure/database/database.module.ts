import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { initOrm } from './mikro-orm.config';

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => initOrm(config.databaseUrl),
    },
  ],
  exports: [MikroORM],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
