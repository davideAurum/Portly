/**
 * "Add this page" requests: `#/add-bookmark?url=<page>&title=<title>` opens the Add bookmark dialog
 * filled in with that page. The browser extension's toolbar button opens Homebase this way
 * (extension/lib/add-page.js). The route renders the dashboard; the dialog is mounted by the shell,
 * so it works whether or not the active profile has a launch pad.
 */
export const ADD_BOOKMARK_ROUTE = '/add-bookmark';
const MAX_URL_LENGTH = 2048;
/** BookmarkTitleSchema's limit. */
const MAX_TITLE_LENGTH = 300;

export interface AddBookmarkRequest {
  url: string;
  /** The page's title, when the request carried one. */
  title: string | null;
}

/** The request in `hash`, or null when it isn't one (or its address isn't an http(s) URL). */
export function parseAddBookmarkRequest(hash: string): AddBookmarkRequest | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const cut = raw.indexOf('?');
  if (cut === -1 || raw.slice(0, cut) !== ADD_BOOKMARK_ROUTE) return null;
  const params = new URLSearchParams(raw.slice(cut + 1));
  const url = params.get('url');
  if (!url || url.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
  } catch {
    return null;
  }
  const title = (params.get('title') ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
  return { url, title: title === '' ? null : title };
}

/** Replaces an add-bookmark hash with the dashboard's (`#/`), so a reload doesn't ask again. */
export function clearAddBookmarkRequest(): void {
  const url = new URL(window.location.href);
  if (!url.hash.startsWith(`#${ADD_BOOKMARK_ROUTE}`)) return;
  url.hash = '#/';
  window.history.replaceState(window.history.state, '', url);
}
