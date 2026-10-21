/**
 * Typed TanStack Query hooks over the generated API. Screens import from
 * here; every request goes through the bearer-token middleware in client.ts.
 * Conventions are in web/CLAUDE.md ("Data layer").
 */
export * from './accounts';
export * from './benefits';
export * from './calc';
export * from './debounce';
export * from './decisions';
export * from './documents';
export * from './explain';
export * from './goals';
export * from './health';
export * from './imports';
export * from './jobs';
export * from './profile';
export * from './recurring';
export * from './setup';
export * from './spending';
export * from './sync';
export * from './transactions';
