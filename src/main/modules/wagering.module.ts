import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  CLOCK,
  ID_GENERATOR,
  METRICS,
  UNIT_OF_WORK,
  type Clock,
  type IdGenerator,
  type Metrics,
  type UnitOfWork,
} from '../../domain/contracts';
import { OpenWallet } from '../../domain/usecases/open-wallet';
import { ReconcileWallet } from '../../domain/usecases/reconcile-wallet';
import { SubmitWagerTransaction } from '../../domain/usecases/submit-wager-transaction';
import { WalletQueries } from '../../domain/usecases/wallet-queries';
import { MikroOrmUnitOfWork } from '../../infra/database/mikro-orm-unit-of-work';
import { nestLogger } from '../../infra/observability/nest-logger';
import { SystemClock, UuidV7Generator } from '../../infra/system/system';
import { WageringController, WalletsController } from '../../presentation/http/wagering.controllers';

@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: UNIT_OF_WORK, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm) },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: OpenWallet,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) => new OpenWallet(uow, ids, clock),
    },
    { provide: WalletQueries, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new WalletQueries(uow) },
    {
      provide: ReconcileWallet,
      inject: [UNIT_OF_WORK, METRICS],
      useFactory: (uow: UnitOfWork, metrics: Metrics) => new ReconcileWallet(uow, metrics, nestLogger(ReconcileWallet.name)),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, METRICS],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock, metrics: Metrics) =>
        new SubmitWagerTransaction(uow, ids, clock, metrics, nestLogger(SubmitWagerTransaction.name)),
    },
  ],
  exports: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, SubmitWagerTransaction],
})
export class WageringModule {}
