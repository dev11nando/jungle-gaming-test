import { Logger } from '@nestjs/common';
import { METRIC, type Metrics } from '../../../shared/application/metrics';
import { REFERENCE_RETRY_POLICY, type ReferenceRetryPolicy } from '../domain/wager-transaction';
import { WagerTransactionStatus } from '../domain/wagering-types';
import type { Clock, IdGenerator, UnitOfWork } from './ports';
import { applyToLockedWallet } from './wager-applier';

export class ProcessPendingReferences {
  private readonly logger = new Logger(ProcessPendingReferences.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly policy: ReferenceRetryPolicy = REFERENCE_RETRY_POLICY,
  ) {}

  async runOnce(limit = 20): Promise<number> {
    const due = await this.uow.read((r) => r.transactions.findDuePendingReferences(this.clock.now(), limit));
    let handled = 0;
    for (const id of due) {
      if (await this.processOne(id)) handled += 1;
    }
    return handled;
  }

  // Lock da wallet antes da linha da transação: mesma ordem da submissão, sem deadlock.
  async processOne(transactionId: string): Promise<boolean> {
    return this.uow.transaction(async (repos) => {
      const peek = await repos.transactions.findById(transactionId);
      if (peek?.status !== WagerTransactionStatus.PendingReference) return false;
      const wallet = await repos.wallets.lockById(peek.walletId);
      const tx = await repos.transactions.lockById(transactionId);
      const now = this.clock.now();
      if (
        wallet === undefined ||
        tx?.status !== WagerTransactionStatus.PendingReference ||
        (tx.nextReferenceAttemptAt !== undefined && tx.nextReferenceAttemptAt > now)
      ) {
        return false;
      }
      const outcome = await applyToLockedWallet({
        repos,
        transaction: tx,
        wallet,
        isNew: false,
        newId: () => this.ids.next(),
        events: { newEventId: () => this.ids.next(), correlationId: tx.id, causationId: tx.id, occurredAt: now },
        retryPolicy: this.policy,
      });
      const result = outcome.type === 'REJECTED' ? outcome.failureCode : outcome.type;
      this.metrics.increment(METRIC.pendingReferenceResolved, { outcome: result });
      if (outcome.type !== 'PENDING_REFERENCE') {
        this.logger.log({
          msg: 'pending reference resolved',
          transactionId: tx.id,
          walletId: tx.walletId,
          providerId: tx.providerId,
          status: tx.status,
          failureCode: tx.failureCode,
        });
      }
      return true;
    });
  }
}
