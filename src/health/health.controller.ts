import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../iam/public.decorator';
import { HealthService, type ReadyReport } from './health.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<ReadyReport> {
    const report = await this.health.ready();
    if (report.status !== 'ok') {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
