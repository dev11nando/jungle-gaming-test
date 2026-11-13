import { Inject, Injectable, Logger } from '@nestjs/common';
import { METRIC, Metrics } from '../../../shared/application/metrics';
import type { EventContext } from '../../../shared/domain/integration-event';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { ConflictError, NotFoundError, TransientInfrastructureError, UniqueViolationError } from './errors';
import { Clock, IdGenerator, UnitOfWork, type Repositories } from './ports';
import { applyToLockedWallet } from './wager-applier';
import type { SubmitWagerCommand } from './wager-command';

export interface SubmitContext {
  correlationId: string;
  causationId?: string;
  /** Presente quando a origem é a fila: grava a inbox na mesma transação SQL. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

export interface SubmitResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

/** Tentativas extras quando um concorrente vence a corrida de unicidade: a próxima passada vira replay. */
const MAX_UNIQUE_RACE_RETRIES = 2;

@Injectable()
export class SubmitWagerTransaction {
  private readonly logger = new Logger(SubmitWagerTransaction.name);

  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(IdGenerator) private readonly ids: IdGenerator,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  async execute(cmd: SubmitWagerCommand, ctx: SubmitContext): Promise<SubmitResult> {
    const started = performance.now();
    try {
      const result = await this.run(cmd, ctx);
      this.metrics.increment(METRIC.transactionsByStatus, {
        status: result.transaction.status,
        kind: result.transaction.kind,
        replay: String(result.idempotentReplay),
      });
      if (result.idempotentReplay) {
        this.metrics.increment(METRIC.duplicatesDetected, { source: ctx.inbox ? 'sqs' : 'http' });
      }
      this.logger.log({
        msg: 'wager transaction handled',
        correlationId: ctx.correlationId,
        messageId: ctx.inbox?.messageId,
        transactionId: result.transaction.id,
        walletId: result.transaction.walletId,
        providerId: result.transaction.providerId,
        kind: result.transaction.kind,
        status: result.transaction.status,
        failureCode: result.transaction.failureCode,
        idempotentReplay: result.idempotentReplay,
      });
      return result;
    } catch (error) {
      if (error instanceof TransientInfrastructureError && error.reason !== 'connection') {
        this.metrics.increment(METRIC.lockConflicts, { reason: error.reason });
      }
      throw error;
    } finally {
      this.metrics.observe(METRIC.processingLatency, (performance.now() - started) / 1000, {
        source: ctx.inbox ? 'sqs' : 'http',
      });
    }
  }

  private async run(cmd: SubmitWagerCommand, ctx: SubmitContext): Promise<SubmitResult> {
    for (let attempt = 0; ; attempt += 1) {
      // Caminho rápido, sem lock: replay de operação já registrada.
      const existing = await this.uow.read((r) => r.transactions.findByIdempotencyKey(cmd.idempotencyKey));
      if (existing !== undefined) {
        return this.replay(existing, cmd, ctx);
      }
      try {
        return await this.uow.transaction((repos) => this.firstSubmission(repos, cmd, ctx));
      } catch (error) {
        if (error instanceof UniqueViolationError && attempt < MAX_UNIQUE_RACE_RETRIES) {
          // Outro processo gravou a mesma chave/inbox entre a leitura e o insert. Nada foi aplicado
          // por esta tentativa (rollback); a próxima volta encontra a linha e responde como replay.
          this.metrics.increment(METRIC.retries, { reason: 'unique_race', constraint: error.constraint ?? 'unknown' });
          continue;
        }
        if (error instanceof UniqueViolationError && error.constraint === 'wager_tx_provider_external_uq') {
          throw externalIdConflict();
        }
        throw error;
      }
    }
  }

  private async firstSubmission(repos: Repositories, cmd: SubmitWagerCommand, ctx: SubmitContext): Promise<SubmitResult> {
    const wallet = await repos.wallets.lockById(cmd.walletId);
    if (wallet === undefined) {
      throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${cmd.walletId} not found`);
    }

    // Com o lock da wallet, operações concorrentes na mesma wallet já estão serializadas:
    // reler a chave aqui enxerga o commit de quem chegou antes.
    const duplicate = await repos.transactions.findByIdempotencyKey(cmd.idempotencyKey);
    if (duplicate !== undefined) {
      this.assertSamePayload(duplicate, cmd);
      await this.recordInbox(repos, ctx, duplicate.id);
      return { transaction: duplicate, idempotentReplay: true };
    }
    const sameExternal = await repos.transactions.findByProviderExternalId(cmd.providerId, cmd.externalTransactionId);
    if (sameExternal !== undefined) {
      throw externalIdConflict();
    }

    const now = this.clock.now();
    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: cmd.payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: cmd.money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });

    await applyToLockedWallet({
      repos,
      transaction: tx,
      wallet,
      isNew: true,
      newId: () => this.ids.next(),
      events: this.eventContext(ctx, now),
    });
    await this.recordInbox(repos, ctx, tx.id);
    return { transaction: tx, idempotentReplay: false };
  }

  private async replay(existing: WagerTransaction, cmd: SubmitWagerCommand, ctx: SubmitContext): Promise<SubmitResult> {
    this.assertSamePayload(existing, cmd);
    if (ctx.inbox !== undefined) {
      // Mesma operação chegando por outra mensagem: registra a entrega, sem novo efeito.
      try {
        await this.uow.transaction((repos) => this.recordInbox(repos, ctx, existing.id));
      } catch (error) {
        if (!(error instanceof UniqueViolationError)) throw error;
      }
    }
    return { transaction: existing, idempotentReplay: true };
  }

  private assertSamePayload(existing: WagerTransaction, cmd: SubmitWagerCommand): void {
    if (!existing.matchesPayload(cmd.payloadHash)) {
      this.metrics.increment(METRIC.idempotencyConflicts);
      throw new ConflictError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key already used with a different payload',
      );
    }
  }

  private async recordInbox(repos: Repositories, ctx: SubmitContext, transactionId: string): Promise<void> {
    if (ctx.inbox === undefined) return;
    const now = this.clock.now();
    const inbox = InboxMessage.receive({ ...ctx.inbox, receivedAt: now });
    inbox.markProcessed(now);
    await repos.inbox.insertProcessed(inbox, transactionId);
  }

  private eventContext(ctx: SubmitContext, now: Date): EventContext {
    return {
      newEventId: () => this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: now,
    };
  }
}

function externalIdConflict(): ConflictError {
  return new ConflictError(
    'EXTERNAL_TRANSACTION_ID_REUSED',
    'externalTransactionId already registered for this provider under a different Idempotency-Key',
  );
}
