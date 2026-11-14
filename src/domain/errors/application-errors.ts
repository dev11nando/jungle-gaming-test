import { DomainError } from './domain-error';

export class NotFoundError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ConflictError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ForbiddenProviderError extends DomainError {
  readonly code = 'PROVIDER_MISMATCH';
  constructor() {
    super('authenticated provider does not match the operation provider');
  }
}

export class TransientInfrastructureError extends Error {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_ERROR';
  constructor(
    message: string,
    readonly reason: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientInfrastructureError';
  }
}

export class UniqueViolationError extends Error {
  constructor(readonly constraint: string | undefined) {
    super(`unique violation${constraint ? ` (${constraint})` : ''}`);
    this.name = 'UniqueViolationError';
  }
}

export class StaleWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleWriteError';
  }
}
