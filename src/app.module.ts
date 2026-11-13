import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { HealthModule } from './health/health.module';
import { IamModule } from './iam/iam.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { WageringModule } from './modules/wagering/wagering.module';

@Module({
  imports: [AppConfigModule, ObservabilityModule, DatabaseModule, IamModule, HealthModule, WageringModule],
})
export class AppModule {}
