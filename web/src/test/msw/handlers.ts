import { http, HttpResponse } from 'msw';
import { API_BASE_URL } from '@/lib/api/client';

export const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

/** Default handlers: the happy path for every route the web app calls. */
export const handlers = [
  http.get(apiUrl('/health'), () =>
    HttpResponse.json({ status: 'ok', git_sha: 'test', alembic_revision: '0001_roles' }),
  ),
];
