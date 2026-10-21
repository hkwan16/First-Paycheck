/**
 * Base URL of the FastAPI service. Every number on screen comes from here.
 * Its own module so MSW handlers can build URLs without importing (and so
 * initializing) the API client and its Supabase dependency.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
