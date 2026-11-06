/**
 * The single URL gate of the web app (§4.4). Every `<a href>`, `window.open` and
 * `location.assign` goes through {@link safeHref} (GitHub Desktop's link has its own builder,
 * {@link githubDesktopHref}); anything that is not an absolute http(s) URL
 * without credentials (≤ 2048 chars, no control characters) — or one of the app's own hash
 * routes — is refused, so `javascript:`, `data:`, `vbscript:`, `file:` and friends can never be
 * navigated to, whatever a provider, feed, bookmark or imported file contains.
 */
import { GITHUB_WEB_URL, OAUTH_RETURN_TO_REGEX, isSafeHttpUrl, parseGitHubRepoName } from '@portly/shared';

export interface SafeHrefOptions {
  /** Also accept in-app hash routes (`#/settings/accounts`). Default true. */
  allowAppRoutes?: boolean;
}

/** An in-app route that also names the field to start in (`#/settings/calendars?focus=ics`). */
const APP_ROUTE_WITH_FOCUS = /^#\/[a-z0-9/_-]*\?focus=[a-z0-9-]{1,32}$/;

/** In-app hash route, e.g. `#/`, `#/settings/import-export` or `#/settings/calendars?focus=ics`. */
export function isAppRoute(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && (OAUTH_RETURN_TO_REGEX.test(value) || APP_ROUTE_WITH_FOCUS.test(value));
}

/**
 * Returns the URL to use as an `href` when it is safe to navigate to, otherwise `undefined`
 * (callers then render plain text instead of a link).
 */
export function safeHref(value: unknown, options: SafeHrefOptions = {}): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if ((options.allowAppRoutes ?? true) && isAppRoute(trimmed)) return trimmed;
  if (!isSafeHttpUrl(trimmed)) return undefined;
  // Return the URL exactly as the browser will navigate to it (normalized by the URL parser).
  return new URL(trimmed).href;
}

/** True for hrefs that leave the app (everything except in-app hash routes). */
export function isExternalHref(href: string): boolean {
  return !href.startsWith('#');
}

export interface LinkTargetProps {
  href: string;
  target?: '_blank';
  rel?: 'noopener noreferrer';
}

/**
 * Anchor props for a (possibly external) link: external links open in a new tab with
 * `rel="noopener noreferrer"` unless `newTab` is false. Returns null for unsafe URLs.
 */
export function linkProps(value: unknown, options: { newTab?: boolean } = {}): LinkTargetProps | null {
  const href = safeHref(value);
  if (href === undefined) return null;
  if (!isExternalHref(href)) return { href };
  const newTab = options.newTab ?? true;
  return newTab ? { href, target: '_blank', rel: 'noopener noreferrer' } : { href };
}

/**
 * Opens a URL in a new tab (`noopener,noreferrer`) or the current tab. Returns false (and does
 * nothing) when the URL is not safe.
 */
export function openUrl(value: unknown, options: { newTab?: boolean } = {}): boolean {
  const href = safeHref(value);
  if (href === undefined) return false;
  if (options.newTab ?? true) {
    window.open(href, '_blank', 'noopener,noreferrer');
  } else {
    window.location.assign(href);
  }
  return true;
}

/** GitHub Desktop's own link for a repository: it opens the repository there, or offers to clone it. */
const GITHUB_DESKTOP_LINK = 'x-github-client://openRepo/';

/**
 * The one address outside http(s) the app may open (§4.4). It is built here from a validated
 * `owner/name`, never taken from a provider or a stored value, so `safeHref` stays http(s) only.
 */
export function githubDesktopHref(fullName: string): string | undefined {
  const repo = parseGitHubRepoName(fullName);
  return repo === null ? undefined : `${GITHUB_DESKTOP_LINK}${GITHUB_WEB_URL}/${repo.owner}/${repo.name}`;
}

/**
 * Hands a repository to GitHub Desktop (the browser asks first; nothing happens where Desktop isn't
 * installed). Returns false for a name that is not a repository's.
 */
export function openInGitHubDesktop(fullName: string): boolean {
  const href = githubDesktopHref(fullName);
  if (href === undefined) return false;
  window.location.assign(href);
  return true;
}

/**
 * Navigates the current tab (e.g. to an OAuth authorize URL — never a popup, §4.7). Returns
 * false when the URL is not an absolute http(s) URL.
 */
export function assignLocation(value: unknown): boolean {
  const href = safeHref(value, { allowAppRoutes: false });
  if (href === undefined) return false;
  window.location.assign(href);
  return true;
}
