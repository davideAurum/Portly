/**
 * The page side of the static build's Microsoft sign-in (see handlers/accounts.ts). Microsoft sends
 * the browser back to the site's own address with `?code&state` (or `?error&state`); before the app
 * renders, main.tsx passes that address to {@link finishSignIn}, which completes the sign-in and
 * returns the address to show instead: the same page with the server build's `?oauth=<result>`
 * and the route the sign-in started from, so App.tsx reports it exactly as after a server sign-in.
 * The code never stays in the address bar or the history.
 *
 * {@link planAutomaticSignIn} is the other half: at page load, when an account's sign-in has ended
 * or is about to, the address of a `prompt=none` sign-in to send the page to (Microsoft answers at
 * once, without a page of its own, while the browser is still signed in to the account).
 */
import { OAUTH_RETURN_TO_REGEX } from '@portly/shared';
import type { StaticContext } from './context.ts';
import { completeAuthorization, planSilentReauth, type CallbackOutcome, type CallbackQuery } from './handlers/accounts.ts';

/** A query parameter: `undefined` when absent, `null` when repeated. */
function single(params: URLSearchParams, name: string): string | null | undefined {
  const values = params.getAll(name);
  if (values.length === 0) return undefined;
  return values.length === 1 ? (values[0] as string) : null;
}

/** The sign-in answer in `url`, or null when the address is not a return from Microsoft. */
export function readCallback(url: URL): CallbackQuery | null {
  const params = url.searchParams;
  if (!params.has('state') || (!params.has('code') && !params.has('error'))) return null;
  return { code: single(params, 'code'), state: single(params, 'state'), error: single(params, 'error') };
}

/** The page to show after a sign-in: same path, no Microsoft parameters, `?oauth=` when there is something to say. */
export function afterSignInUrl(url: URL, outcome: CallbackOutcome): string {
  const target = new URL(url.pathname, url.origin);
  if (outcome.result !== null) target.searchParams.set('oauth', outcome.result);
  target.hash = outcome.returnTo;
  return target.href;
}

/** Completes a sign-in when `href` is Microsoft's answer; returns the address to replace it with, else null. */
export async function finishSignIn(ctx: StaticContext, href: string): Promise<string | null> {
  const url = new URL(href);
  const query = readCallback(url);
  if (query === null) return null;
  return afterSignInUrl(url, await completeAuthorization(ctx, query));
}

/**
 * The address of an automatic sign-in to go to now, or null. Never right after a sign-in (the
 * page still shows its `?oauth=` result) and only for the route the page is on.
 */
export async function planAutomaticSignIn(ctx: StaticContext, href: string): Promise<string | null> {
  const url = new URL(href);
  if (url.searchParams.has('oauth') || readCallback(url) !== null) return null;
  const returnTo = OAUTH_RETURN_TO_REGEX.test(url.hash) ? url.hash : '#/';
  return planSilentReauth(ctx, returnTo);
}
