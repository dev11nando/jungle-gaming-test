import { Logger } from '@nestjs/common';
import { JsonLogger } from '../src/infra/observability/json-logger';

Logger.overrideLogger(new JsonLogger(process.env.LOG_LEVEL ?? 'silent'));
