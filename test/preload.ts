import { Logger } from '@nestjs/common';
import { JsonLogger } from '../src/modules/observability/json-logger';

// Testes silenciosos por padrão; LOG_LEVEL=log bun test ... para depurar.
Logger.overrideLogger(new JsonLogger(process.env.LOG_LEVEL ?? 'silent'));
