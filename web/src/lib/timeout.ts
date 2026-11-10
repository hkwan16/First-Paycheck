/** A wait that ran out: the promise it bounded never settled in time. */
export class TimedOut extends Error {
  constructor(milliseconds: number) {
    super(`No answer within ${milliseconds} ms`);
    this.name = 'TimedOut';
  }
}

/**
 * `promise`, or a `TimedOut` rejection after `milliseconds`, whichever comes
 * first. The promise itself keeps running; this only stops waiting for it.
 * For calls with no timeout of their own that must never leave a person
 * waiting forever (a Supabase session read or sign-out, issues 224 and 225).
 */
export function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut(milliseconds)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
