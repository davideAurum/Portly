/**
 * "Add this page to Homebase" (lib/add-page.js): the request hash, the pass-through filter and
 * the toolbar button's click handler with fake chrome.action / chrome.tabs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ADD_BOOKMARK_ROUTE,
  MAX_TITLE_LENGTH,
  UNSUPPORTED_TITLE,
  addBookmarkHash,
  addPage,
  forwardedHash,
  registerAddPage,
} from '../lib/add-page.js';
import { createEvent, flush } from './helpers.mjs';

const ID = 'nbaolbakegefnefgojdokagajincnfjj';

function createChrome({ tabs = true, failCreate = false } = {}) {
  const calls = [];
  const record = (name) => async (details) => {
    calls.push([name, details]);
  };
  return {
    calls,
    runtime: { id: ID, getURL: (path) => `chrome-extension://${ID}/${path}` },
    tabs: tabs
      ? {
          async create(props) {
            calls.push(['tabs.create', props]);
            if (failCreate) throw new Error('No window');
            return { id: 99, ...props };
          },
        }
      : undefined,
    action: {
      onClicked: createEvent(),
      setBadgeText: record('setBadgeText'),
      setBadgeBackgroundColor: record('setBadgeBackgroundColor'),
      setTitle: record('setTitle'),
    },
  };
}

describe('addBookmarkHash', () => {
  it('encodes the address and the title', () => {
    const hash = addBookmarkHash('https://example.com/a?b=1&c=2#top', 'An  article\n title ');
    assert.ok(hash?.startsWith(`${ADD_BOOKMARK_ROUTE}?`));
    const params = new URLSearchParams(hash.slice(ADD_BOOKMARK_ROUTE.length + 1));
    assert.equal(params.get('url'), 'https://example.com/a?b=1&c=2#top');
    assert.equal(params.get('title'), 'An article title');
    assert.ok(!hash.slice(1).includes('#'), 'the page\'s own fragment is encoded');
  });

  it('leaves out a missing title, or one that is just the address', () => {
    for (const title of [undefined, '', '   ', 'https://example.com/', 42]) {
      assert.equal(addBookmarkHash('https://example.com/', title), `${ADD_BOOKMARK_ROUTE}?url=${encodeURIComponent('https://example.com/')}`);
    }
  });

  it('caps the title', () => {
    const params = new URLSearchParams(addBookmarkHash('https://example.com/', 'x'.repeat(500)).split('?')[1]);
    assert.equal(params.get('title').length, MAX_TITLE_LENGTH);
  });

  it('refuses anything but http(s) pages', () => {
    for (const url of [
      'chrome://extensions/',
      'edge://settings',
      'chrome-extension://abc/newtab.html',
      'file:///C:/notes.html',
      'about:blank',
      'javascript:alert(1)',
      'data:text/html,hi',
      'https://user:secret@example.com/',
      `https://example.com/${'a'.repeat(2100)}`,
      'not a url',
      undefined,
    ]) {
      assert.equal(addBookmarkHash(url, 'Title'), null, String(url));
    }
    assert.notEqual(addBookmarkHash('http://192.168.1.10:8080/', 'Router'), null);
  });
});

describe('forwardedHash', () => {
  it('keeps a valid request and drops everything else', () => {
    const request = addBookmarkHash('https://example.com/', 'Example');
    assert.equal(forwardedHash(request), request);
    for (const hash of [undefined, '', '#/', '#/settings/general', `${ADD_BOOKMARK_ROUTE}`, `${ADD_BOOKMARK_ROUTE}?url=chrome%3A%2F%2Fsettings`]) {
      assert.equal(forwardedHash(hash), '', String(hash));
    }
  });
});

describe('toolbar button', () => {
  it('opens Homebase next to the current tab with the page to add', async () => {
    const chrome = createChrome();
    const result = await addPage(chrome, { id: 7, index: 3, windowId: 2, url: 'https://example.com/post', title: 'A post' });
    assert.equal(result, 'opened');
    assert.deepEqual(chrome.calls, [
      [
        'tabs.create',
        {
          url: `chrome-extension://${ID}/newtab.html${addBookmarkHash('https://example.com/post', 'A post')}`,
          active: true,
          index: 4,
          openerTabId: 7,
          windowId: 2,
        },
      ],
    ]);
  });

  it('marks the tab with a "!" badge and explains, for pages that cannot be added', async () => {
    const chrome = createChrome();
    const result = await addPage(chrome, { id: 7, index: 0, url: 'chrome://extensions/', title: 'Extensions' });
    assert.equal(result, 'unsupported');
    assert.deepEqual(chrome.calls, [
      ['setBadgeBackgroundColor', { tabId: 7, color: '#b45309' }],
      ['setBadgeText', { tabId: 7, text: '!' }],
      ['setTitle', { tabId: 7, title: UNSUPPORTED_TITLE }],
    ]);
  });

  it('treats a tab whose address it may not read (no url) as unsupported', async () => {
    const chrome = createChrome();
    assert.equal(await addPage(chrome, { id: 1, index: 0 }), 'unsupported');
    assert.equal(chrome.calls.some(([name]) => name === 'tabs.create'), false);
  });

  it('logs and swallows failures', async () => {
    const logged = [];
    const log = (level, message) => logged.push([level, message]);
    assert.equal(await addPage(createChrome({ failCreate: true }), { id: 1, index: 0, url: 'https://example.com/' }, log), 'error');
    assert.equal(await addPage(createChrome({ tabs: false }), { id: 1, index: 0, url: 'https://example.com/' }, log), 'error');
    assert.equal(logged.length, 2);
    assert.match(logged[0][1], /No window/);
  });

  it('registers a click listener, and nothing where there is no chrome.action', async () => {
    const chrome = createChrome();
    registerAddPage(chrome);
    assert.equal(chrome.action.onClicked.listeners.length, 1);
    chrome.action.onClicked.dispatch({ id: 5, index: 0, url: 'https://example.com/' });
    await flush();
    assert.equal(chrome.calls[0][0], 'tabs.create');
    assert.doesNotThrow(() => registerAddPage({ runtime: chrome.runtime }));
  });
});
