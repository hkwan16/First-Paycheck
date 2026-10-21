import { describe, expect, it } from 'vitest';
import { maskLabel } from './accounts';

describe('maskLabel', () => {
  it('prefixes the last digits with two middle dots, as the mockup does', () => {
    expect(maskLabel('4821')).toBe('··4821');
    expect(maskLabel(null)).toBeNull();
    expect(maskLabel('')).toBeNull();
  });
});
