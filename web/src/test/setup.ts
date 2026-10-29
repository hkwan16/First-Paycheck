import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { settleAnimationFrames } from './animation-frames';
import { resetCheckinDb } from './msw/checkin-handlers';
import { resetDb } from './msw/db';
import { resetJobScripts } from './msw/handlers';
import { resetPlanDb } from './msw/plan-handlers';
import { resetPlanningDb } from './msw/planning-handlers';
import { server } from './msw/server';
import { resetSpendingDb } from './msw/spending-handlers';

// Any request without a handler is a test bug, not a network call.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetDb();
  resetJobScripts();
  resetSpendingDb();
  resetPlanningDb();
  resetCheckinDb();
  resetPlanDb();
});
afterAll(async () => {
  server.close();
  // Run the frames still queued (Recharts' batched updates) before vitest
  // closes jsdom, or their fallback timers fire into a window that is gone.
  await settleAnimationFrames();
});
