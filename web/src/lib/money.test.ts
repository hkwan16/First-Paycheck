import { describe, expect, it } from 'vitest';
import { formatMoney, formatNumber, formatPct, parseMoney } from './money';

describe('formatMoney', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [199604, '$1,996.04'],
    [270833, '$2,708.33'],
    [6500000, '$65,000.00'],
    [-1230, '-$12.30'],
    [123456789012, '$1,234,567,890.12'],
  ])('formats %i cents as %s', (cents, expected) => {
    expect(formatMoney(cents)).toBe(expected);
  });

  it.each([
    [6500000, '$65,000'],
    [182325, '$1,823'],
    [182350, '$1,824'],
    [182349, '$1,823'],
    [-150, '-$2'],
    [-149, '-$1'],
    [-49, '$0'],
    [49, '$0'],
    [50, '$1'],
  ])('with decimals 0, rounds %i cents half away from zero to %s', (cents, expected) => {
    expect(formatMoney(cents, { decimals: 0 })).toBe(expected);
  });

  it('signs gains and losses when asked, never zero', () => {
    expect(formatMoney(85754, { signed: true })).toBe('+$857.54');
    expect(formatMoney(-8215, { signed: true })).toBe('-$82.15');
    expect(formatMoney(0, { signed: true })).toBe('$0.00');
  });

  it.each([1.5, Number.NaN, Infinity, 2 ** 53])('rejects %s, which is not integer cents', (bad) => {
    expect(() => formatMoney(bad)).toThrow(RangeError);
  });
});

describe('parseMoney', () => {
  it.each([
    ['1,234.56', 123456],
    ['$1,234.56', 123456],
    ['  $12 ', 1200],
    ['12.5', 1250],
    ['0.05', 5],
    ['.50', 50],
    ['-12.30', -1230],
    ['-$12.30', -1230],
    ['2708.33', 270833],
    ['0', 0],
  ])('parses %j as %i cents', (text, cents) => {
    expect(parseMoney(text)).toBe(cents);
  });

  it.each([
    '',
    ' ',
    'abc',
    '12.345',
    '1,23',
    '12,34.00',
    '$',
    '-',
    '1.2.3',
    '1e5',
    '99999999999999999',
  ])('rejects %j', (text) => {
    expect(parseMoney(text)).toBeNull();
  });

  it('round-trips with formatMoney', () => {
    for (const cents of [0, 1, 99, 100, 199604, -5000, 123456789]) {
      expect(parseMoney(formatMoney(cents))).toBe(cents);
    }
  });
});

describe('formatPct', () => {
  it.each([
    [4, 0, '4%'],
    ['4.00', 0, '4%'],
    [12.25, 1, '12.3%'],
    [0.5, 1, '0.5%'],
    [100, 0, '100%'],
    ['24.5', 2, '24.50%'],
  ] as const)('formats %j percentage points with %i decimals as %s', (points, decimals, out) => {
    expect(formatPct(points, { decimals })).toBe(out);
  });

  it('rejects text that is not a number', () => {
    expect(() => formatPct('four')).toThrow(RangeError);
  });
});

describe('formatNumber', () => {
  it('groups thousands and fixes decimals', () => {
    expect(formatNumber(14.21, { decimals: 2 })).toBe('14.21');
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatNumber(-3, { signed: true })).toBe('-3');
    expect(formatNumber(3, { signed: true })).toBe('+3');
  });
});
