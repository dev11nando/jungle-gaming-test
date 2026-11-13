import { DomainError } from '../../../shared/domain/domain-error';

/** Recurso ausente (404). */
export class NotFoundError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Conflito de estado (409): wallet duplicada, idempotency key com outro payload, etc. */
export class ConflictError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Provedor autenticado diferente do provedor da operação (403). */
export class ForbiddenProviderError extends DomainError {
  readonly code = 'PROVIDER_MISMATCH';
  constructor() {
    super('authenticated provider does not match the operation provider');
  }
}

/**
 * Falha transitória de infraestrutura (503): banco fora, timeout de lock, deadlock,
 * serialização. O cliente pode reenviar a mesma requisição com segurança.
 */
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

/** Violação de unicidade traduzida pela persistência, com o nome da constraint. */
export class UniqueViolationError extends Error {
  constructor(readonly constraint: string | undefined) {
    super(`unique violation${constraint ? ` (${constraint})` : ''}`);
    this.name = 'UniqueViolationError';
  }
}

/** UPDATE condicionado à versão não afetou linha: alguém escreveu sem o lock. */
export class StaleWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleWriteError';
  }
}
