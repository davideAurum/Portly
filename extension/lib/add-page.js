// @ts-check
/**
 * "Add this page to Homebase" (the toolbar button). Clicking the extension's icon opens a new tab
 * next to the current one at this extension's own new tab page with
 * `#/add-bookmark?url=<page>&title=<page title>`. That page opens Homebase exactly as a new tab
 * does (the Pages site, or Homebase on this PC — started first when it isn't running) and passes
 * the hash on; Homebase then shows its Add bookmark dialog filled in with the page.
 *
 * The extension never writes the bookmark itself: the launch pad lives wherever the Homebase page
 * keeps its data (the server on this PC when paired, else the Pages site's in-browser copy), and
 * the dialog lets you pick the group. The tab's address and title are readable on a click thanks
 * to `activeTab` (no "tabs" permission). Only http(s) pages can be added; on anything else the
 * button shows a "!" badge on that tab and says why in its tooltip.
 */

/** The Homebase hash route that asks for the Add bookmark dialog (web: launchpad/addRequest.ts). */
export const ADD_BOOKMARK_ROUTE = '#/add-bookmark';
export const MAX_URL_LENGTH = 2048;
export const MAX_TITLE_LENGTH = 300;
export const ACTION_TITLE = 'Add this page to Homebase';
export const UNSUPPORTED_TITLE = 'Only web pages (http or https) can be added to Homebase';

/**
 * The hash that asks Homebase to add `url` (titled `title`), or null when the address can't be a
 * bookmark (not http(s), credentials in it, too long).
 * @param {unknown} url
 * @param {unknown} [title]
 * @returns {string | null}
 */
export function addBookmarkHash(url, title) {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') return null;
  const params = new URLSearchParams({ url: parsed.href });
  const cleanTitle = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH) : '';
  // A tab without a title of its own reports its address as the title: leave that to Homebase.
  if (cleanTitle !== '' && cleanTitle !== url && cleanTitle !== parsed.href) params.set('title', cleanTitle);
  return `${ADD_BOOKMARK_ROUTE}?${params.toString()}`;
}

/**
 * The part of a hash a new tab passes on to Homebase: an add-bookmark request, rebuilt from its
 * validated parameters (so nothing else rides along), or '' for anything else.
 * @param {unknown} hash
 * @returns {string}
 */
export function forwardedHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(`${ADD_BOOKMARK_ROUTE}?`)) return '';
  const params = new URLSearchParams(hash.slice(ADD_BOOKMARK_ROUTE.length + 1));
  return addBookmarkHash(params.get('url'), params.get('title')) ?? '';
}

/**
 * @typedef {object} TabLike the part of chrome.tabs.Tab used here
 * @property {number} [id]
 * @property {number} [index]
 * @property {number} [windowId]
 * @property {string} [url]
 * @property {string} [title]
 *
 * @typedef {object} AddPageChrome
 * @property {{ getURL(path: string): string }} runtime
 * @property {{ create(props: { url: string, index?: number, openerTabId?: number, windowId?: number, active?: boolean }): unknown }} [tabs]
 * @property {{
 *   onClicked: { addListener(listener: (tab: TabLike) => void): void },
 *   setBadgeText?(details: { tabId?: number, text: string }): unknown,
 *   setBadgeBackgroundColor?(details: { tabId?: number, color: string }): unknown,
 *   setTitle?(details: { tabId?: number, title: string }): unknown,
 * }} [action]
 */

/**
 * Handles one click on the toolbar button. Never throws.
 * @param {AddPageChrome} chromeApi
 * @param {TabLike | undefined} tab
 * @param {(level: 'info' | 'warn', message: string) => void} [log]
 * @returns {Promise<'opened' | 'unsupported' | 'error'>}
 */
export async function addPage(chromeApi, tab, log = () => {}) {
  const hash = addBookmarkHash(tab?.url, tab?.title);
  const action = chromeApi.action;
  const tabId = typeof tab?.id === 'number' ? tab.id : undefined;
  try {
    if (hash === null) {
      // Per tab: the badge and tooltip go back to normal when the tab navigates.
      await action?.setBadgeBackgroundColor?.({ tabId, color: '#b45309' });
      await action?.setBadgeText?.({ tabId, text: '!' });
      await action?.setTitle?.({ tabId, title: UNSUPPORTED_TITLE });
      return 'unsupported';
    }
    if (!chromeApi.tabs) throw new Error('chrome.tabs is unavailable');
    /** @type {{ url: string, index?: number, openerTabId?: number, windowId?: number, active: boolean }} */
    const props = { url: `${chromeApi.runtime.getURL('newtab.html')}${hash}`, active: true };
    if (typeof tab?.index === 'number') props.index = tab.index + 1;
    if (tabId !== undefined) props.openerTabId = tabId;
    if (typeof tab?.windowId === 'number') props.windowId = tab.windowId;
    await chromeApi.tabs.create(props);
    return 'opened';
  } catch (err) {
    log('warn', `Couldn't add the page to Homebase: ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  }
}

/**
 * Registers the toolbar button's click listener. Call it synchronously from the service worker's
 * top level (MV3). Does nothing where the browser has no chrome.action.
 * @param {AddPageChrome} chromeApi
 * @param {{ log?: (level: 'info' | 'warn', message: string) => void }} [deps]
 */
export function registerAddPage(chromeApi, deps = {}) {
  chromeApi.action?.onClicked.addListener((tab) => {
    void addPage(chromeApi, tab, deps.log);
  });
}
