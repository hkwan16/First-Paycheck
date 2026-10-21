import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('joins conditional classes', () => {
    expect(cn('a', false, undefined, null, 'b', { c: true, d: false })).toBe('a b c');
  });

  it('keeps a custom font size next to a custom text color', () => {
    expect(cn('text-small text-ink-3')).toBe('text-small text-ink-3');
    expect(cn('text-tiny', 'text-blue-text')).toBe('text-tiny text-blue-text');
  });

  it('lets a later token of the same group win', () => {
    expect(cn('text-small', 'text-tiny')).toBe('text-tiny');
    expect(cn('text-ink', 'text-blue-text')).toBe('text-blue-text');
    expect(cn('bg-fill', 'bg-blue-tint')).toBe('bg-blue-tint');
    expect(cn('rounded-card', 'rounded-tile')).toBe('rounded-tile');
    expect(cn('shadow-card', 'shadow-raised')).toBe('shadow-raised');
  });

  it('knows the custom breakpoints', () => {
    expect(cn('max-nav:flex-row', 'max-nav:flex-col')).toBe('max-nav:flex-col');
  });
});
