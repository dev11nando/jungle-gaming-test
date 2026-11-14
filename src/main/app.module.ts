import { Module } from '@nestjs/common';
import { AppConfigModule } from './modules/app-config.module';
import { HealthModule } from './modules/health.module';
import { IamModule } from './modules/iam.module';
import { DatabaseModule } from './modules/database.module';
import { MessagingModule } from './modules/messaging.module';
import { ObservabilityModule } from './modules/observability.module';
import { WageringModule } from './modules/wagering.module';

@Module({
  imports: [AppConfigModule, ObservabilityModule, DatabaseModule, IamModule, HealthModule, WageringModule, MessagingModule],
})
export class AppModule {}
