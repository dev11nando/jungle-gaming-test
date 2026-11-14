import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Public } from '../../infra/auth/public.decorator';
import { PrometheusMetrics } from '../../infra/observability/prometheus-metrics';

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  render(): string {
    return this.metrics.render();
  }
}
