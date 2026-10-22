/** Errors already logged: Strict Mode runs effects twice, and the log should say it once. */
const logged = new WeakSet<object>();

/**
 * Log a caught render error with `console.error`, once per error object (a
 * thrown string or number cannot be remembered, so it is logged each time).
 * Error reporting in the browser stops here: there is no web Sentry.
 */
export function logErrorOnce(label: string, error: unknown): void {
  if (typeof error === 'object' && error !== null) {
    if (logged.has(error)) return;
    logged.add(error);
  }
  console.error(label, error);
}
