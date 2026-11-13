import { randomUUID } from 'node:crypto';
import { Money } from '../../src/modules/wagering/domain/money';
import { wagerPayloadHash } from '../../src/modules/wagering/domain/payload-hash';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wagering-types';
import { Wallet } from '../../src/modules/wagering/domain/wallet';

export const T0 = new Date('2026-07-29T15:00:00.000Z');

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export function openWallet(initial = '100.00', playerId = 'player-1'): Wallet {
  const wallet = Wallet.open({
    id: randomUUID(),
    playerId,
    initialBalance: brl(initial),
    at: T0,
    opening: { transactionId: randomUUID(), entryId: randomUUID() },
  });
  wallet.pullUncommittedEntries();
  return wallet;
}

let seq = 0;

export function wager(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<{
    externalTransactionId: string;
    referenceExternalTransactionId: string;
    roundId: string;
    playerId: string;
    providerId: string;
    currency: string;
  }> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${++seq}`;
  const providerId = overrides.providerId ?? 'provider-a';
  const money = Money.from({ amount, currency: overrides.currency ?? 'BRL' });
  const payload = {
    providerId,
    externalTransactionId,
    playerId: overrides.playerId ?? wallet.playerId,
    walletId: wallet.id,
    roundId: overrides.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: money.toJSON(),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
  };
  return WagerTransaction.create({
    ...payload,
    id: randomUUID(),
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    payloadHash: wagerPayloadHash(payload),
    money,
    createdAt: T0,
  });
}
