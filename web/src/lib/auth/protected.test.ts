import { describe, expect, it } from 'vitest';
import { requiresSignIn } from './protected';

/** The URL path a page file serves: route groups drop out, dynamic segments get a sample value. */
function urlOf(file: string): string {
  const segments = file
    .replace(/^.*\/app\//, '')
    .replace(/\/?page\.tsx$/, '')
    .split('/')
    .filter((s) => s && !/^\(.+\)$/.test(s))
    .map((s) => (/^\[.+\]$/.test(s) ? 'sample_id' : s));
  return `/${segments.join('/')}`;
}

// Keys only: the pages are never imported.
const pageFiles = Object.keys(import.meta.glob('../../app/**/page.tsx'));

describe('requiresSignIn', () => {
  it('covers every page in the (app) route group, the screens behind the guard', () => {
    const appPages = pageFiles.filter((file) => file.includes('/(app)/'));
    expect(appPages.length).toBeGreaterThan(5);
    for (const file of appPages) expect(requiresSignIn(urlOf(file)), file).toBe(true);
  });

  it('leaves every other page open: home, sign-in and the development screens', () => {
    const others = pageFiles.filter((file) => !file.includes('/(app)/'));
    expect(others.map(urlOf)).toEqual(expect.arrayContaining(['/', '/sign-in', '/dev/kit']));
    for (const file of others) expect(requiresSignIn(urlOf(file)), file).toBe(false);
    expect(requiresSignIn('/auth/callback')).toBe(false);
  });

  it('matches whole segments only', () => {
    expect(requiresSignIn('/plan')).toBe(true);
    expect(requiresSignIn('/plan/')).toBe(true);
    expect(requiresSignIn('/setup/confirm/doc_1')).toBe(true);
    expect(requiresSignIn('/planner')).toBe(false);
    expect(requiresSignIn('/setups')).toBe(false);
    expect(requiresSignIn('/why-us')).toBe(false);
  });
});
