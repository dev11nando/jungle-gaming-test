import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { HealthModule } from './health/health.module';
import { IamModule } from './iam/iam.module';

@Module({
  imports: [AppConfigModule, HealthModule, IamModule],
})
export class AppModule {}
