import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InvalidInputError, InvariantViolationError } from '../../../shared/domain/domain-error';
import {
  ConflictError,
  ForbiddenProviderError,
  NotFoundError,
  StaleWriteError,
  TransientInfrastructureError,
  UniqueViolationError,
} from '../application/errors';

export interface ErrorBody {
  error: { code: string; message: string };
  correlationId?: string;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { correlationId?: string }>();
    const { status, code, message } = this.classify(exception);

    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', '1');
      this.logger.warn({ msg: 'transient failure', correlationId: request.correlationId, code, path: request.path });
    } else if (status >= 500) {
      this.logger.error({
        msg: 'unhandled error',
        correlationId: request.correlationId,
        path: request.path,
        error: exception instanceof Error ? exception.name : 'unknown',
        detail: exception instanceof Error ? exception.message : undefined,
      });
    }

    const body: ErrorBody = { error: { code, message }, correlationId: request.correlationId };
    response.status(status).json(body);
  }

  private classify(exception: unknown): { status: number; code: string; message: string } {
    if (exception instanceof InvalidInputError || exception instanceof InvariantViolationError) {
      return { status: HttpStatus.BAD_REQUEST, code: exception.code, message: exception.message };
    }
    if (exception instanceof NotFoundError) {
      return { status: HttpStatus.NOT_FOUND, code: exception.code, message: exception.message };
    }
    if (exception instanceof ConflictError) {
      return { status: HttpStatus.CONFLICT, code: exception.code, message: exception.message };
    }
    if (exception instanceof ForbiddenProviderError) {
      return { status: HttpStatus.FORBIDDEN, code: exception.code, message: exception.message };
    }
    if (
      exception instanceof TransientInfrastructureError ||
      exception instanceof UniqueViolationError ||
      exception instanceof StaleWriteError
    ) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'TRANSIENT_INFRASTRUCTURE_ERROR',
        message: 'temporary failure, safe to retry with the same Idempotency-Key',
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const raw = typeof res === 'string' ? res : (res as { message?: unknown }).message;
      const message = Array.isArray(raw) ? raw.join('; ') : String(raw ?? exception.message);
      const code =
        status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_REQUEST' : 'HTTP_ERROR';
      return { status, code, message };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL_ERROR', message: 'internal error' };
  }
}
