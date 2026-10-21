import { describe, expect, it } from 'vitest';
import { hardNavigate } from './navigation';

describe('hardNavigate', () => {
  it('navigates the whole document (jsdom performs only fragment navigations)', () => {
    hardNavigate('#signed-in');
    expect(window.location.hash).toBe('#signed-in');
  });
});
