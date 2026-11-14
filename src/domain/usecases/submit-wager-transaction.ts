import { METRIC, type Clock, type IdGenerator, type Logger, type Metrics, type Repositories, type UnitOfWork } from '../contracts';
import type { EventContext } from '../events/integration-event';
import { InboxMessage } from '../entities/inbox-message';
import { WagerTransaction } from '../entities/wager-transaction';
import { ConflictError, NotFoundError, TransientInfrastructureError, UniqueViolationError } from '../errors/application-errors';
import { applyToLockedWallet } from './wager-applier';
import type { SubmitWagerCommand } from './wager-command';

export interface SubmitContext {
  correlationId: string;
  causationId?: string;
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

export interface SubmitResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

const MAX_UNIQUE_RACE_RETRIES = 2;

export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
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
      this.logger.info({
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
      const existing = await this.uow.read((r) => r.transactions.findByIdempotencyKey(cmd.idempotencyKey));
      if (existing !== undefined) {
        return this.replay(existing, cmd, ctx);
      }
      try {
        return await this.uow.transaction((repos) => this.firstSubmission(repos, cmd, ctx));
      } catch (error) {
        // Um concorrente gravou a mesma chave; esta tentativa foi desfeita e a próxima vira replay.
        if (error instanceof UniqueViolationError && attempt < MAX_UNIQUE_RACE_RETRIES) {
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

    // Releitura sob o lock da wallet: enxerga o commit de quem chegou antes.
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
