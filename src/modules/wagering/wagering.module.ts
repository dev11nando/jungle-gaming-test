import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SystemClock, UuidV7Generator } from '../../infrastructure/system/system';
import { Clock, IdGenerator, UnitOfWork } from './application/ports';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { OpenWallet, ReconcileWallet, WalletQueries } from './application/wallet-use-cases';
import { WageringController, WalletsController } from './http/wagering.controllers';
import { MikroOrmUnitOfWork } from './infrastructure/mikro-orm-unit-of-work';

@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: UnitOfWork, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm) },
    { provide: IdGenerator, useClass: UuidV7Generator },
    { provide: Clock, useClass: SystemClock },
    OpenWallet,
    WalletQueries,
    ReconcileWallet,
    SubmitWagerTransaction,
  ],
  exports: [UnitOfWork, IdGenerator, Clock, SubmitWagerTransaction],
})
export class WageringModule {}
