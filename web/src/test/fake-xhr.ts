import { vi } from 'vitest';

type Handler = ((event: ProgressEvent) => void) | null;

/**
 * One request made through the fake XMLHttpRequest. The test drives it:
 * `progress(loaded, total)` fires the upload's progress event, `respond()`
 * finishes it, `fail()` is a network error.
 */
export class FakeXhr {
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = '';
  readyState = 0;
  aborted = false;
  private responseHeaders: Record<string, string> = {};

  upload: { onprogress: Handler } = { onprogress: null };
  onload: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;

  constructor(private readonly registry: FakeXhr[]) {}

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }

  send(body: unknown) {
    this.body = body;
    this.registry.push(this);
  }

  abort() {
    this.aborted = true;
    this.onabort?.(new ProgressEvent('abort'));
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }

  /** The form field `name` of a multipart body. */
  field(name: string): FormDataEntryValue | null {
    return this.body instanceof FormData ? this.body.get(name) : null;
  }

  progress(loaded: number, total: number) {
    this.upload.onprogress?.(
      new ProgressEvent('progress', { lengthComputable: true, loaded, total }),
    );
  }

  respond(status: number, body: unknown = null, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = body === null ? '' : JSON.stringify(body);
    this.responseHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    this.readyState = 4;
    this.onload?.(new ProgressEvent('load'));
  }

  fail() {
    this.readyState = 4;
    this.onerror?.(new ProgressEvent('error'));
  }
}

/**
 * Replace XMLHttpRequest for the current test (uploads only; fetch still goes
 * through MSW). Restored by `vi.unstubAllGlobals()`, which the caller runs in
 * `afterEach`.
 */
export function installFakeXhr() {
  const requests: FakeXhr[] = [];
  vi.stubGlobal(
    'XMLHttpRequest',
    class extends FakeXhr {
      constructor() {
        super(requests);
      }
    },
  );
  return {
    requests,
    /** The latest request, failing the test if there is none. */
    last(): FakeXhr {
      const request = requests.at(-1);
      if (!request) throw new Error('No XMLHttpRequest was sent');
      return request;
    },
  };
}
