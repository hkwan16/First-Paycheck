import { describe, expect, it } from 'vitest';
import { sampleCashflow } from '@/test/fixtures/cashflow';
import { nextFocus } from './keyboard';
import { layoutCashFlow } from './layout';

const layout = layoutCashFlow(sampleCashflow(), 928);
const move = (id: string, key: string) => nextFocus(layout, id, key);

describe('nextFocus', () => {
  it('moves up and down within a column and stops at its ends', () => {
    expect(move('line:federal_withholding', 'ArrowDown')).toBe('line:social_security');
    expect(move('line:social_security', 'ArrowUp')).toBe('line:federal_withholding');
    expect(move('line:federal_withholding', 'ArrowUp')).toBeNull();
    expect(move('take-home', 'ArrowDown')).toBeNull();
    expect(move('gross', 'ArrowDown')).toBeNull();
  });

  it('jumps to the first and last node of the column with Home and End', () => {
    expect(move('line:medicare', 'Home')).toBe('line:federal_withholding');
    expect(move('line:medicare', 'End')).toBe('take-home');
  });

  it('follows the bands right to where the money went', () => {
    expect(move('gross', 'ArrowRight')).toBe('line:federal_withholding');
    expect(move('take-home', 'ArrowRight')).toBe('bucket:essentials');
    expect(move('bucket:flexible', 'ArrowRight')).toBe('category:dining');
  });

  it('follows the band left to where the money came from', () => {
    expect(move('category:shopping', 'ArrowLeft')).toBe('bucket:flexible');
    expect(move('bucket:savings', 'ArrowLeft')).toBe('take-home');
    expect(move('line:medicare', 'ArrowLeft')).toBe('gross');
  });

  it('without a band, goes to the nearest node of the next or previous column', () => {
    // Not yet spent has no categories; Dining is the category level with its middle.
    expect(move('bucket:left_over', 'ArrowRight')).toBe('category:dining');
    // The $0 401(k) has no band in; gross pay is the only node to its left.
    expect(move('line:retirement_contribution', 'ArrowLeft')).toBe('gross');
    // The first line has no band out; the nearest bucket is the top one.
    expect(move('line:federal_withholding', 'ArrowRight')).toBe('bucket:essentials');
  });

  it('stops at the outer columns and ignores other keys', () => {
    expect(move('gross', 'ArrowLeft')).toBeNull();
    expect(move('category:housing', 'ArrowRight')).toBeNull();
    expect(move('gross', 'Enter')).toBeNull();
    expect(move('nope', 'ArrowDown')).toBeNull();
  });
});
