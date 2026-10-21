/**
 * Typed TanStack Query hooks over the generated API. Screens import from
 * here; every request goes through the bearer-token middleware in client.ts.
 * Conventions are in web/CLAUDE.md ("Data layer").
 */
export * from './accounts';
export * from './calc';
export * from './debounce';
export * from './decisions';
export * from './documents';
export * from './explain';
export * from './health';
export * from './jobs';
export * from './profile';
export * from './setup';
export * from './sync';
export * from './transactions';
