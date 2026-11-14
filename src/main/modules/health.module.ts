import { Module } from '@nestjs/common';
import { HealthController } from '../../presentation/http/health.controller';
import { HealthService } from '../../infra/health/health.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
