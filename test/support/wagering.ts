import type { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import type { Pool } from 'pg';
import { SystemClock, UuidV7Generator } from '../../src/infra/system/system';
import { PrometheusMetrics } from '../../src/infra/observability/prometheus-metrics';
import type { Repositories, UnitOfWork } from '../../src/domain/contracts';
import { nestLogger } from '../../src/infra/observability/nest-logger';
import { SubmitWagerTransaction } from '../../src/domain/usecases/submit-wager-transaction';
import { parseSubmitWagerCommand, type SubmitWagerCommand } from '../../src/domain/usecases/wager-command';
import { OpenWallet } from '../../src/domain/usecases/open-wallet';
import { ReconcileWallet } from '../../src/domain/usecases/reconcile-wallet';
import { WalletQueries } from '../../src/domain/usecases/wallet-queries';
import { Money } from '../../src/domain/entities/money';
import { MikroOrmUnitOfWork } from '../../src/infra/database/mikro-orm-unit-of-work';

export const testLogger = nestLogger('test');

export interface Services {
  uow: UnitOfWork;
  metrics: PrometheusMetrics;
  openWallet: OpenWallet;
  submit: SubmitWagerTransaction;
  queries: WalletQueries;
  reconcile: ReconcileWallet;
}

export function buildServices(orm: MikroORM, uow: UnitOfWork = new MikroOrmUnitOfWork(orm)): Services {
  const ids = new UuidV7Generator();
  const clock = new SystemClock();
  const metrics = new PrometheusMetrics();
  return {
    uow,
    metrics,
    openWallet: new OpenWallet(uow, ids, clock),
    submit: new SubmitWagerTransaction(uow, ids, clock, metrics, testLogger),
    queries: new WalletQueries(uow),
    reconcile: new ReconcileWallet(uow, metrics, testLogger),
  };
}

export class FailingUnitOfWork implements UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly sabotage: (repos: Repositories) => Repositories,
  ) {}
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.inner.transaction((repos) => work(this.sabotage(repos)));
  }
  read<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.inner.read(work);
  }
}

let counter = 0;

export function wagerBody(
  walletId: string,
  playerId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  counter += 1;
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${Date.now()}-${counter}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

export function command(body: Record<string, unknown>, key?: string): SubmitWagerCommand {
  return parseSubmitWagerCommand(body, key ?? `${String(body.providerId)}:${String(body.externalTransactionId)}`);
}

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

export async function ledgerSnapshot(pool: Pool, walletId: string) {
  const { rows } = await pool.query<{ balance: string; ledger: string; entries: number; debits: number; credits: number }>(
    `select w.balance_amount::text as balance,
            coalesce((select sum(case direction when 'CREDIT' then amount else -amount end)
                        from wallet_ledger_entries e where e.wallet_id = w.id), 0)::text as ledger,
            (select count(*)::int from wallet_ledger_entries e where e.wallet_id = w.id) as entries,
            (select count(*)::int from wallet_ledger_entries e where e.wallet_id = w.id and direction = 'DEBIT') as debits,
            (select count(*)::int from wallet_ledger_entries e where e.wallet_id = w.id and direction = 'CREDIT') as credits
       from wallets w where w.id = $1`,
    [walletId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`wallet ${walletId} not found`);
  return { ...row, ledger: Money.fromStored(row.ledger, 'BRL').amount };
}

export async function assertAllWalletsReconcile(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ id: string; balance: string; ledger: string }>(
    `select w.id, w.balance_amount::text as balance,
            coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(19,2)::text as ledger
       from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
      group by w.id`,
  );
  const divergent = rows.filter((r) => r.balance !== r.ledger);
  expect(divergent).toEqual([]);
}
