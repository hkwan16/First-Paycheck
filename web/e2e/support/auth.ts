import path from 'node:path';
import { expect, type Page } from '@playwright/test';

/** Where auth.setup.ts saves the signed-in browser state for the `authenticated` project. */
export const STORAGE_STATE = path.join(__dirname, '..', '.auth', 'user.json');

/** A fresh, signed-out browser state for tests that sign in through the form themselves. */
export const SIGNED_OUT = { cookies: [], origins: [] };

export const NO_SUPABASE =
  'Skipped: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (web/.env.local) to run the auth e2e tests against a Supabase project.';

export const NO_E2E_USER =
  'Skipped: set E2E_USER_EMAIL and E2E_USER_PASSWORD (a confirmed user in that Supabase project, see web/CLAUDE.md) to run the signed-in e2e tests.';

export function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
  );
}

export interface E2EUser {
  email: string;
  password: string;
}

/** The e2e account, or null when Supabase or the credentials are not configured. */
export function e2eUser(): E2EUser | null {
  const email = process.env.E2E_USER_EMAIL?.trim();
  const password = process.env.E2E_USER_PASSWORD;
  return supabaseConfigured() && email && password ? { email, password } : null;
}

export const NO_ALPHA_USER =
  'Skipped: set E2E_ALPHA_USER_EMAIL and E2E_ALPHA_USER_PASSWORD (a new, confirmed user with no data; scripts/e2e_stack.py makes one per run) to run the alpha path.';

/**
 * The account alpha.spec.ts walks through the whole alpha with: it must be new
 * (no bank, no pay stub, no decisions), so it is not the shared e2e user.
 */
export function alphaUser(): E2EUser | null {
  const email = process.env.E2E_ALPHA_USER_EMAIL?.trim();
  const password = process.env.E2E_ALPHA_USER_PASSWORD;
  return supabaseConfigured() && email && password ? { email, password } : null;
}

/** Wait for React to hydrate before interacting, so no event lands on dead HTML. */
export async function waitForHydration(page: Page) {
  await page.locator('html[data-hydrated="true"]').waitFor();
}

/** Fill and submit the sign-in form on the current /sign-in page. */
export async function submitSignIn(page: Page, email: string, password: string) {
  await waitForHydration(page);
  const form = page.getByRole('form', { name: 'Sign in' });
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Sign in' }).click();
}

/** Sign in through the form from /sign-in and wait for the first setup step. */
export async function signIn(page: Page, user: E2EUser) {
  await page.goto('/sign-in');
  await submitSignIn(page, user.email, user.password);
  await expect(page).toHaveURL('/setup/link');
}
