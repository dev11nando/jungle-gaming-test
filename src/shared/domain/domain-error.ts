/**
 * Erro de regra de domínio. `code` é estável e legível por máquina.
 * Não carrega status HTTP: o mapeamento fica na borda.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada que não respeita o contrato (formato, escala, campo obrigatório). */
export class InvalidInputError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Violação de invariante de um agregado (ex.: saldo negativo). */
export class InvariantViolationError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Erro de programação: transição a partir de estado terminal.
 * Não é caminho de negócio — indica bug no chamador.
 */
export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}
