import type { Route } from 'next';

/*
 * Builders for the id-bound screens. Next's typed `Route` accepts a dynamic
 * segment only as a string literal at the call site, so links built from API
 * ids go through these functions: one place that knows the URL shape and
 * encodes the id as a single segment.
 */

function segment(id: string): string {
  if (id === '') throw new RangeError('A route id must not be empty');
  return encodeURIComponent(id);
}

export const confirmRoute = (documentId: string) =>
  `/setup/confirm/${segment(documentId)}` as Route;

export const whyRoute = (decisionId: string) => `/why/${segment(decisionId)}` as Route;

export const checkInRoute = (checkInId: string) => `/check-in/${segment(checkInId)}` as Route;
