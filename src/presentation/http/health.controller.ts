import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../infra/auth/public.decorator';
import { HealthService, type ReadyReport } from '../../infra/health/health.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadyReport> {
    const report = await this.health.ready();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
