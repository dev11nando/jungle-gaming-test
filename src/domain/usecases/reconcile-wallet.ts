import { METRIC, type Logger, type Metrics, type UnitOfWork } from '../contracts';
import type { Money } from '../entities/money';
import { NotFoundError } from '../errors/application-errors';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  // Leitura com a wallet travada para comparar saldo e ledger no mesmo instante. Nunca corrige.
  async execute(walletId: string, ctx: { correlationId: string }): Promise<ReconciliationReport> {
    const report = await this.uow.transaction(async (repos) => {
      const wallet = await repos.wallets.lockById(walletId);
      if (wallet === undefined) throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
      const summary = await repos.ledger.summarize(walletId, wallet.currency);
      const difference = wallet.balance.subtract(summary.balance);
      return {
        walletId,
        storedBalance: wallet.balance,
        calculatedBalance: summary.balance,
        difference,
        consistent: difference.isZero(),
        checkedEntries: summary.entries,
      };
    });
    if (!report.consistent) {
      this.metrics.increment(METRIC.reconciliationDivergences);
      this.logger.error({
        msg: 'wallet balance diverges from ledger',
        correlationId: ctx.correlationId,
        walletId,
        difference: report.difference.amount,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}
