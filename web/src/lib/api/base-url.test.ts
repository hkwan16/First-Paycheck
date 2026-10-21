import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('API_BASE_URL', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is NEXT_PUBLIC_API_URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example');
    const { API_BASE_URL } = await import('./base-url');
    expect(API_BASE_URL).toBe('https://api.example');
  });

  it('defaults to the local API', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', undefined);
    const { API_BASE_URL } = await import('./base-url');
    expect(API_BASE_URL).toBe('http://localhost:8000');
  });
});
