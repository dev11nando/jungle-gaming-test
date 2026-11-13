import { Controller, Get, Global, Header, Inject, Module } from '@nestjs/common';
import { Metrics } from '../../shared/application/metrics';
import { Public } from '../../iam/public.decorator';
import { PrometheusMetrics } from './prometheus-metrics';

@Public()
@Controller('metrics')
class MetricsController {
  constructor(@Inject(Metrics) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  render(): string {
    return this.metrics.render();
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [{ provide: Metrics, useClass: PrometheusMetrics }],
  exports: [Metrics],
})
export class ObservabilityModule {}
