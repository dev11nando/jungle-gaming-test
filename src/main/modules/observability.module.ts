import { Global, Module } from '@nestjs/common';
import { METRICS } from '../../domain/contracts';
import { PrometheusMetrics } from '../../infra/observability/prometheus-metrics';
import { MetricsController } from '../../presentation/http/metrics.controller';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [PrometheusMetrics, { provide: METRICS, useExisting: PrometheusMetrics }],
  exports: [METRICS],
})
export class ObservabilityModule {}
