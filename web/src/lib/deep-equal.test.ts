import { describe, expect, it } from 'vitest';
import { deepEqual } from './deep-equal';

describe('deepEqual', () => {
  it.each([
    [1, 1],
    ['4.00', '4.00'],
    [null, null],
    [true, true],
    [[], []],
    [{}, {}],
    [
      { a: 1, b: [{ c: '2' }] },
      { b: [{ c: '2' }], a: 1 },
    ],
  ])('treats %j and %j as equal', (a, b) => {
    expect(deepEqual(a, b)).toBe(true);
  });

  it.each([
    [1, 2],
    ['4', '4.00'],
    [4, '4'],
    [null, undefined],
    [null, {}],
    [
      [1, 2],
      [2, 1],
    ],
    [[1], [1, 1]],
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: 1, b: undefined }, { a: 1 }],
    [{ a: [1] }, { a: { 0: 1 } }],
  ])('tells %j from %j', (a, b) => {
    expect(deepEqual(a, b)).toBe(false);
    expect(deepEqual(b, a)).toBe(false);
  });
});
