import { IntegrationEvent, type EventContext } from './integration-event';
import type { MoneyProps } from '../entities/money';
import type { WagerTransaction } from '../entities/wager-transaction';
import type { FailureCode, LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from '../entities/wagering-types';
import type { Wallet } from '../entities/wallet';
import type { WalletLedgerEntry } from '../entities/wallet-ledger-entry';

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balance?: MoneyProps;
}

function transactionData(tx: WagerTransaction): WagerTransactionEventData {
  const data: WagerTransactionEventData = {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
  };
  if (tx.referenceExternalTransactionId !== undefined) data.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  if (tx.referenceTransactionId !== undefined) data.referenceTransactionId = tx.referenceTransactionId;
  if (tx.failureCode !== undefined) data.failureCode = tx.failureCode;
  if (tx.resultBalance !== undefined) data.balance = tx.resultBalance.toJSON();
  return data;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(IntegrationEvent.propsFrom(tx.id, ctx, transactionData(tx)));
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(IntegrationEvent.propsFrom(tx.id, ctx, transactionData(tx)));
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(IntegrationEvent.propsFrom(tx.id, ctx, transactionData(tx)));
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.propsFrom(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}
