import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { uuidV7 } from '../../../infrastructure/system/system';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type RequestWithCorrelation = Request & { correlationId?: string };

export function correlationMiddleware(req: RequestWithCorrelation, res: Response, next: NextFunction): void {
  const incoming = req.header('x-correlation-id');
  const id = incoming !== undefined && SAFE_ID.test(incoming) ? incoming : uuidV7();
  req.correlationId = id;
  res.setHeader('X-Correlation-Id', id);
  next();
}

export const CorrelationId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<RequestWithCorrelation>();
  return req.correlationId ?? uuidV7();
});
