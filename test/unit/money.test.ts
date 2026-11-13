import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/modules/wagering/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('normaliza para escala fixa de 2 casas', () => {
    expect(brl('25').amount).toBe('25.00');
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('0.01').amount).toBe('0.01');
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E2',
    '0x10',
    '-1.00',
    '+1.00',
    '1.001',
    '1.',
    '.5',
    '01.00',
    '1,00',
    ' 1.00',
    '1.00 ',
    '100000000000000000.00',
  ])('rejeita entrada inválida %p', (amount) => {
    expect(() => brl(amount)).toThrow(expect.objectContaining({ code: 'INVALID_MONEY' }));
  });

  test('rejeita amount que não é string', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: 0.1 as unknown as string, currency: 'BRL' })).toThrow();
  });

  test.each(['brl', 'BR', 'BRLL', '', '12A'])('rejeita moeda inválida %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(expect.objectContaining({ code: 'INVALID_MONEY' }));
  });

  test('aritmética exata, sem ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    expect(brl('1.00').subtract(brl('2.50')).amount).toBe('-1.50');
    expect(brl('99999999999999999.99').minorUnits).toBe(9999999999999999999n);
  });

  test('é imutável: operações devolvem nova instância', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(b).not.toBe(a);
  });

  test('negate, comparações e predicados', () => {
    expect(brl('3.10').negate().amount).toBe('-3.10');
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('operações entre moedas diferentes lançam CURRENCY_MISMATCH', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(expect.objectContaining({ code: 'CURRENCY_MISMATCH' }));
    expect(() => brl('1.00').subtract(usd)).toThrow(expect.objectContaining({ code: 'CURRENCY_MISMATCH' }));
    expect(() => brl('1.00').isLessThan(usd)).toThrow(expect.objectContaining({ code: 'CURRENCY_MISMATCH' }));
  });

  test('reidrata numeric persistido como string, inclusive negativo', () => {
    expect(Money.fromStored('975.00', 'BRL').amount).toBe('975.00');
    expect(Money.fromStored('-0.50', 'BRL').minorUnits).toBe(-50n);
    expect(() => Money.fromStored('1.234', 'BRL')).toThrow();
  });

  test('estoura acima de numeric(19,2)', () => {
    expect(() => brl('99999999999999999.99').add(brl('0.01'))).toThrow(expect.objectContaining({ code: 'INVALID_MONEY' }));
  });
});
