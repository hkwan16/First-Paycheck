import type { Middleware } from 'openapi-fetch';
import { ApiError, isApiErrorBody } from './errors';

/**
 * A non-2xx response that is not the API's answer (issue 289): a proxy's bare
 * 502, a cut-off connection, the host's own page. An `ApiError` with the
 * status and no code, so `apiErrorMessage` shows the screen's fallback and
 * `isUnanswered` offers to try again, as for a request that got no answer.
 */
export class NoApiAnswer extends ApiError {
  constructor(status: number) {
    super(status, undefined);
    this.name = 'NoApiAnswer';
    this.message = `The API did not answer (${status})`;
  }
}

/** The body as the API's error shape, or undefined for an empty or foreign one. */
function apiErrorBodyOf(text: string): unknown {
  try {
    const body: unknown = JSON.parse(text);
    return isApiErrorBody(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/**
 * openapi-fetch middleware that refuses every non-2xx response the API did
 * not write. `openapi-react-query` throws only when the parsed `error` is
 * truthy, so a non-2xx response with an empty body would resolve as success
 * with no data and a screen would show an empty state. Here any `!response.ok`
 * whose body is not `{ error: { code, message } }` throws `NoApiAnswer`; one
 * in the API's shape goes through unchanged (its code and message are read
 * downstream). The body is read from a copy, so it stays readable.
 */
export const answerMiddleware: Middleware = {
  async onResponse({ response }) {
    if (response.ok) return undefined;
    const text = await response.clone().text();
    if (apiErrorBodyOf(text) !== undefined) return undefined;
    throw new NoApiAnswer(response.status);
  },
};
