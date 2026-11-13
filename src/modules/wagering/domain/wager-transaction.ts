import { InvalidInputError, InvalidTransactionStateError } from '../../../shared/domain/domain-error';
import { Money } from './money';
import { FailureCode, LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from './wagering-types';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  completedAt?: Date;
  resultBalance?: Money;
  resultWalletVersion?: number;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

/**
 * Política de reprocessamento de PENDING_REFERENCE.
 * Backoff exponencial base 1s, teto 60s; desiste após 8 tentativas ou 15 minutos desde createdAt.
 */
export const REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 8,
  ttlMs: 15 * 60_000,
};

export interface ReferenceRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  ttlMs: number;
}

/** Provedor reservado para transações internas (OPENING). Não pode ser usado por provedores reais. */
export const INTERNAL_PROVIDER_ID = 'internal';

/**
 * Transições válidas:
 *   PENDING           → PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
 *   PENDING_REFERENCE → PROCESSED | PENDING_REFERENCE (nova tentativa) | REJECTED | FAILED
 * PROCESSED, REJECTED e FAILED são terminais.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _completedAt?: Date,
    private _resultBalance?: Money,
    private _resultWalletVersion?: number,
    private _referenceAttempts = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida campos obrigatórios e a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    for (const field of [
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const) {
      const value = props[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidInputError('INVALID_FIELD', `${field} is required`);
      }
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidInputError('INVALID_KIND', `unknown kind ${String(props.kind)}`);
    }
    if (props.money.isNegative()) {
      throw new InvalidInputError('INVALID_MONEY', 'amount cannot be negative');
    }
    const needsReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    const reference = props.referenceExternalTransactionId;
    if (needsReference && (reference === undefined || reference.trim() === '')) {
      throw new InvalidInputError('REFERENCE_REQUIRED', `${props.kind} requires referenceExternalTransactionId`);
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidInputError('INVALID_REFERENCE', 'a transaction cannot reference itself');
    }
    if (props.kind !== WagerTransactionKind.Loss && props.money.isZero()) {
      throw new InvalidInputError('INVALID_MONEY', `${props.kind} amount must be greater than zero`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /**
   * Transação interna de abertura, já PROCESSED. Escopo próprio (`provider_id = 'internal'`),
   * para não colidir com chaves de provedores.
   */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    at: Date;
  }): WagerTransaction {
    const key = `internal:opening:${props.walletId}`;
    const tx = new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      `opening:${props.walletId}`,
      key,
      props.payloadHash,
      props.walletId,
      props.playerId,
      'opening',
      'opening',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.at,
      WagerTransactionStatus.Pending,
    );
    tx.markProcessed(undefined, props.at, { balance: props.money, walletVersion: 1 });
    return tx;
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.completedAt,
      s.resultBalance,
      s.resultWalletVersion,
      s.referenceAttempts,
      s.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  /** Momento em que atingiu um estado terminal (PROCESSED, REJECTED ou FAILED). */
  get completedAt(): Date | undefined {
    return this._completedAt;
  }
  /** Saldo observado quando a transação terminou — base do replay idempotente. */
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get resultWalletVersion(): number | undefined {
    return this._resultWalletVersion;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observed: { balance: Money; walletVersion: number },
  ): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._completedAt = at;
    this._resultBalance = observed.balance;
    this._resultWalletVersion = observed.walletVersion;
    this._nextReferenceAttemptAt = undefined;
  }

  /** PENDING → PENDING_REFERENCE, agendando a primeira nova tentativa. */
  markPendingReference(now: Date, policy: ReferenceRetryPolicy = REFERENCE_RETRY_POLICY): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference from ${this._status}`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = new Date(now.getTime() + policy.baseDelayMs);
  }

  /**
   * Registra uma tentativa sem sucesso de resolver a referência.
   * Retorna `false` quando o limite foi esgotado — o chamador deve rejeitar com REFERENCE_NOT_FOUND.
   */
  scheduleReferenceRetry(now: Date, policy: ReferenceRetryPolicy = REFERENCE_RETRY_POLICY): boolean {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`scheduleReferenceRetry from ${this._status}`);
    }
    const attempts = this._referenceAttempts + 1;
    const expired = now.getTime() - this.createdAt.getTime() >= policy.ttlMs;
    if (attempts >= policy.maxAttempts || expired) {
      this._referenceAttempts = attempts;
      return false;
    }
    const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempts);
    this._referenceAttempts = attempts;
    this._nextReferenceAttemptAt = new Date(now.getTime() + delay);
    return true;
  }

  reject(code: FailureCode, at: Date, observed?: { balance: Money; walletVersion: number }): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._completedAt = at;
    this._resultBalance = observed?.balance;
    this._resultWalletVersion = observed?.walletVersion;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._completedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  isProcessed(): boolean {
    return this._status === WagerTransactionStatus.Processed;
  }

  /** false para LOSS. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento. ROLLBACK inverte a direção da referência
   * (BET→CREDIT, WIN→DEBIT, REFUND→DEBIT).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (reference === undefined) {
          throw new InvalidTransactionStateError('ROLLBACK direction requires the reference');
        }
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not move balance');
    }
  }

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${operation} on terminal transaction ${this.id} (${this._status})`);
    }
  }
}
