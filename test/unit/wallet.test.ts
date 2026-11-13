import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../../src/modules/wagering/domain/money';
import { LedgerDirection } from '../../src/modules/wagering/domain/wagering-types';
import { Wallet } from '../../src/modules/wagering/domain/wallet';
import { WalletLedgerEntry } from '../../src/modules/wagering/domain/wallet-ledger-entry';
import { brl, openWallet, T0 } from '../support/domain-fixtures';

const move = () => ({ transactionId: randomUUID(), entryId: randomUUID(), at: T0 });

describe('Wallet', () => {
  test('abre com versão 1 e lançamento OPENING quando o saldo inicial é positivo', () => {
    const wallet = Wallet.open({
      id: 'w1',
      playerId: 'p1',
      initialBalance: brl('1000.00'),
      at: T0,
      opening: { transactionId: 't1', entryId: 'e1' },
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('1000.00');
    const [entry, ...rest] = wallet.pullUncommittedEntries();
    expect(rest).toHaveLength(0);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.amount).toBe('0.00');
    expect(entry?.balanceAfter.amount).toBe('1000.00');
    expect(entry?.walletVersion).toBe(1);
  });

  test('abre com saldo zero sem lançamento', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: Money.zero('BRL'), at: T0 });
    expect(wallet.version).toBe(1);
    expect(wallet.pullUncommittedEntries()).toHaveLength(0);
  });

  test('saldo inicial positivo exige transação OPENING', () => {
    expect(() => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('1.00'), at: T0 })).toThrow();
  });

  test('débito e crédito incrementam a versão e geram lançamento balanceado', () => {
    const wallet = openWallet('100.00');
    const debit = wallet.debit(brl('25.00'), move());
    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(debit.isBalanced()).toBe(true);
    expect(debit.walletVersion).toBe(2);
    const credit = wallet.credit(brl('5.00'), move());
    expect(wallet.balance.amount).toBe('80.00');
    expect(wallet.version).toBe(3);
    expect(credit.balanceBefore.amount).toBe('75.00');
    expect(wallet.pullUncommittedEntries()).toHaveLength(2);
  });

  test('nunca fica negativa: débito acima do saldo lança INSUFFICIENT_FUNDS e não muda estado', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(brl('100.01'), move())).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.pullUncommittedEntries()).toHaveLength(0);
    wallet.debit(brl('100.00'), move());
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('moeda da operação deve ser a da wallet', () => {
    const wallet = openWallet('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit(usd, move())).toThrow(expect.objectContaining({ code: 'CURRENCY_MISMATCH' }));
    expect(() => wallet.debit(usd, move())).toThrow(expect.objectContaining({ code: 'CURRENCY_MISMATCH' }));
  });

  test('movimento de valor zero não é permitido (não há mudança de saldo sem efeito)', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(Money.zero('BRL'), move())).toThrow();
  });

  test('saldo == soma do ledger depois de vários movimentos', () => {
    const wallet = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl('50.00'),
      at: T0,
      opening: { transactionId: 't', entryId: 'e' },
    });
    wallet.debit(brl('10.00'), move());
    wallet.credit(brl('33.33'), move());
    wallet.debit(brl('0.01'), move());
    const entries = wallet.pullUncommittedEntries();
    const sum = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero('BRL'));
    expect(sum.equals(wallet.balance)).toBe(true);
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('30.00'),
    balanceAfter: brl('20.00'),
    walletVersion: 2,
    createdAt: T0,
  };

  test('create valida a aritmética', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('21.00') })).toThrow(
      expect.objectContaining({ code: 'LEDGER_UNBALANCED' }),
    );
    expect(() => WalletLedgerEntry.create({ ...base, money: brl('0.00'), balanceAfter: brl('30.00') })).toThrow();
  });

  test('é estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('999.00');
    }).toThrow();
  });
});
