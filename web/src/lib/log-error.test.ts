import { afterEach, describe, expect, it, vi } from 'vitest';
import { logErrorOnce } from './log-error';

afterEach(() => vi.restoreAllMocks());

describe('logErrorOnce', () => {
  it('logs an error with its label the first time only', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('boom');
    logErrorOnce('[Card] failed', error);
    logErrorOnce('[Card] failed', error);
    expect(consoleError).toHaveBeenCalledExactlyOnceWith('[Card] failed', error);
  });

  it('logs each distinct error, and values that are not objects every time', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logErrorOnce('[Card] failed', new Error('one'));
    logErrorOnce('[Card] failed', new Error('two'));
    logErrorOnce('[Card] failed', 'a thrown string');
    logErrorOnce('[Card] failed', 'a thrown string');
    expect(consoleError).toHaveBeenCalledTimes(4);
  });
});
