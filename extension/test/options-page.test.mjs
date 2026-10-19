import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createLauncher } from '../lib/launcher.js';
import {
  LAUNCHER_UNAVAILABLE,
  PAGES_URL_ERROR,
  PORT_ERROR,
  createOptionsPage,
  describeExtensionId,
  describePing,
} from '../lib/options-page.js';
import {
  HEALTH_BODY,
  NATIVE_ERRORS,
  OLD_PATH_EXTENSION_ID,
  PINNED_EXTENSION_ID,
  createFetch,
  createNativeRuntime,
  createStorage,
  createTimers,
  down,
  flush,
  jsonResponse,
  loadPage,
  ok,
} from './helpers.mjs';

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

async function setup({ storage = createStorage(), fetch = createFetch(ok), runtime = null, timers = undefined } = {}) {
  const window = loadPage('options.html');
  const document = window.document;
  const launcher = createLauncher(runtime, timers ?? {});
  const page = createOptionsPage({ document, storage, fetch, launcher, extensionId: runtime?.id ?? null });
  cleanups.push(() => {
    page.destroy();
    window.close();
  });
  await page.init();
  const $ = (id) => document.getElementById(id);
  return { window, document, storage, fetch, runtime, page, $ };
}

function submit(t) {
  t.$('port-form').dispatchEvent(new t.window.Event('submit', { bubbles: true, cancelable: true }));
}

describe('options page', () => {
  it('shows the stored port (or the default)', async () => {
    const stored = await setup({ storage: createStorage({ port: 6123 }) });
    assert.equal(stored.$('port').value, '6123');
    assert.equal(stored.document.querySelector('[data-portly-url]').textContent, 'http://localhost:6123');

    const fresh = await setup();
    assert.equal(fresh.$('port').value, '5757');
  });

  it('saves a valid port as a number', async () => {
    const t = await setup({ storage: createStorage({ target: 'local' }) });
    t.$('port').value = ' 5800 ';
    submit(t);
    await flush();
    assert.deepEqual(t.storage.data, { target: 'local', port: 5800 });
    assert.equal(t.$('port').value, '5800');
    assert.equal(t.$('status').textContent, 'Saved. New tabs will open http://localhost:5800.');
    assert.equal(t.$('port-error').hidden, true);
    assert.equal(t.document.querySelector('[data-portly-url]').textContent, 'http://localhost:5800');
  });

  it('with the Pages target, says what the port is for', async () => {
    const t = await setup();
    t.$('port').value = '5800';
    submit(t);
    await flush();
    assert.deepEqual(t.storage.data, { port: 5800 });
    assert.equal(t.$('status').textContent, 'Saved. The extension looks for Portly on this PC at http://localhost:5800.');
    for (const node of t.document.querySelectorAll('[data-portly-url]')) assert.equal(node.textContent, 'http://localhost:5800');
    // The Pages site looks for Portly at the address it was built with, never at this port.
    const pagesSummary = t.document.querySelector('[data-summary="pages"]');
    assert.equal(pagesSummary.querySelector('[data-portly-url]'), null);
    assert.doesNotMatch(pagesSummary.textContent, /5800/);
  });

  for (const value of ['', 'abc', '80', '1023', '65536', '5757.0', '+5757', '1e4', '0x1F90', '-1']) {
    it(`rejects ${JSON.stringify(value)} without touching storage`, async () => {
      const t = await setup({ storage: createStorage({ port: 6000 }) });
      t.$('port').value = value;
      assert.equal(await t.page.save(), null);
      assert.deepEqual(t.storage.calls.set, []);
      assert.deepEqual(t.storage.data, { port: 6000 });
      assert.equal(t.$('port-error').hidden, false);
      assert.equal(t.$('port-error').textContent, PORT_ERROR);
      assert.equal(t.$('port').getAttribute('aria-invalid'), 'true');
      assert.equal(t.document.activeElement, t.$('port'));
    });
  }

  it('clears the error once the input becomes valid', async () => {
    const t = await setup();
    t.$('port').value = 'x';
    await t.page.save();
    t.$('port').value = '6000';
    t.$('port').dispatchEvent(new t.window.Event('input', { bubbles: true }));
    assert.equal(t.$('port-error').hidden, true);
    assert.equal(t.$('port').hasAttribute('aria-invalid'), false);
  });

  it('resets to the default port', async () => {
    const t = await setup({ storage: createStorage({ port: 6000 }) });
    t.$('reset').click();
    await flush();
    assert.deepEqual(t.storage.data, { port: 5757 });
    assert.equal(t.$('port').value, '5757');
  });

  it('reports storage failures', async () => {
    const t = await setup({ storage: createStorage({}, { failSet: true }) });
    t.$('port').value = '6000';
    assert.equal(await t.page.save(), null);
    assert.match(t.$('status').textContent, /Couldn't save the port: quota exceeded/);
    assert.equal(t.$('status').classList.contains('status-error'), true);
  });

  it('tests the port in the field without saving it', async () => {
    const t = await setup({ fetch: createFetch(ok) });
    t.$('port').value = '6100';
    t.$('test').click();
    await flush();
    assert.equal(t.fetch.calls[0].url, 'http://localhost:6100/api/health');
    assert.equal(t.$('status').textContent, 'Portly is running on port 6100 (version 0.1.0).');
    assert.equal(t.$('test').disabled, false);
    assert.deepEqual(t.storage.calls.set, []);
  });

  it('mentions a locked vault and explains failures', async () => {
    const locked = await setup({ fetch: createFetch(() => jsonResponse({ ...HEALTH_BODY, vault: 'locked' })) });
    await locked.page.test();
    assert.match(locked.$('status').textContent, /vault is locked/);

    const offline = await setup({ fetch: createFetch(down) });
    await offline.page.test();
    assert.equal(offline.$('status').textContent, 'Nothing is answering on http://localhost:5757.');
    assert.equal(offline.$('status').classList.contains('status-error'), true);
  });

  it('does not test an invalid port', async () => {
    const t = await setup();
    t.$('port').value = '99';
    assert.equal(await t.page.test(), null);
    assert.equal(t.fetch.calls.length, 0);
  });
});

describe('options page: what a new tab opens', () => {
  const radio = (t, value) => t.document.querySelector(`input[name="target"][value="${value}"]`);
  const visibleSummary = (t) =>
    [...t.document.querySelectorAll('[data-summary]')].filter((node) => !node.hidden).map((node) => node.dataset.summary);
  const autoText = (t) => t.document.querySelector('[data-server-site]').textContent;
  const pagesText = (t) => t.document.querySelector('[data-pages-url]').textContent;
  const SITE = 'https://me.github.io/';
  const known = (pagesUrl, port = 5757) => ({ serverSite: { port, pagesUrl } });

  function choose(t, value) {
    radio(t, value).click(); // checks it and fires "change"
  }

  it('defaults to following Portly on this PC, with no built-in Pages address', async () => {
    const t = await setup();
    assert.equal(radio(t, 'auto').checked, true);
    assert.equal(radio(t, 'pages').checked, false);
    assert.equal(radio(t, 'local').checked, false);
    assert.deepEqual(visibleSummary(t), ['auto']);
    assert.equal(autoText(t), 'Portly itself, http://localhost:5757, until it answers this browser');
    assert.equal(t.$('pages-url').value, '');
    assert.equal(t.$('pages-url').placeholder, '');
    assert.match(pagesText(t), /^not set yet/);
    assert.equal(t.page.savedTarget, 'auto');
    assert.equal(t.page.savedPagesUrl, null);
    assert.deepEqual(t.storage.calls.set, [], 'opening the page saves nothing');
  });

  it('shows what Portly on this PC reported', async () => {
    const withSite = await setup({ storage: createStorage(known(SITE)) });
    assert.equal(autoText(withSite), `its Pages site, ${SITE}`);
    assert.equal(withSite.$('pages-url').placeholder, SITE);
    assert.equal(pagesText(withSite), SITE);
    const withoutSite = await setup({ storage: createStorage(known(null)) });
    assert.equal(autoText(withoutSite), 'Portly itself, http://localhost:5757');
    const otherPort = await setup({ storage: createStorage({ port: 6001, ...known(SITE) }) });
    assert.equal(autoText(otherPort), 'Portly itself, http://localhost:6001, until it answers this browser');
  });

  it('shows the stored choice and address', async () => {
    const t = await setup({ storage: createStorage({ target: 'local', pagesUrl: 'https://me.github.io/portly-pages/' }) });
    assert.equal(radio(t, 'local').checked, true);
    assert.deepEqual(visibleSummary(t), ['local']);
    assert.equal(t.$('pages-url').value, 'https://me.github.io/portly-pages/');
  });

  it('shows the defaults for invalid stored values', async () => {
    const t = await setup({ storage: createStorage({ target: 'remote', pagesUrl: 'ftp://me.example/' }) });
    assert.equal(radio(t, 'auto').checked, true);
    assert.equal(t.$('pages-url').value, '');
  });

  it('saves a choice as soon as it is picked', async () => {
    const t = await setup({ storage: createStorage({ port: 6001 }) });
    choose(t, 'local');
    await flush();
    assert.deepEqual(t.storage.data, { port: 6001, target: 'local' });
    assert.equal(t.$('newtab-status').textContent, 'Saved. New tabs will open Portly on this PC, http://localhost:6001.');
    assert.equal(t.$('newtab-status').classList.contains('status-ok'), true);
    assert.deepEqual(visibleSummary(t), ['local']);

    choose(t, 'pages');
    await flush();
    assert.equal(t.storage.data.target, 'pages');
    assert.equal(
      t.$('newtab-status').textContent,
      'Saved. Enter the Pages site address below; until then new tabs open Portly on this PC.',
    );
    assert.deepEqual(visibleSummary(t), ['pages']);

    choose(t, 'auto');
    await flush();
    assert.equal(t.storage.data.target, 'auto');
    assert.equal(
      t.$('newtab-status').textContent,
      'Saved. New tabs will follow Portly on this PC: Portly itself, http://localhost:6001, until it answers this browser.',
    );
    assert.deepEqual(visibleSummary(t), ['auto']);
  });

  it('confirms the Pages site a choice will open', async () => {
    const t = await setup({ storage: createStorage(known(SITE)) });
    choose(t, 'pages');
    await flush();
    assert.equal(t.$('newtab-status').textContent, `Saved. New tabs will open the Pages site, ${SITE}.`);
    choose(t, 'auto');
    await flush();
    assert.equal(t.$('newtab-status').textContent, `Saved. New tabs will follow Portly on this PC: its Pages site, ${SITE}.`);
  });

  it('puts the previous choice back when saving fails', async () => {
    const t = await setup({ storage: createStorage({}, { failSet: true }) });
    choose(t, 'local');
    await flush();
    assert.equal(radio(t, 'auto').checked, true);
    assert.equal(radio(t, 'local').checked, false);
    assert.match(t.$('newtab-status').textContent, /Couldn't save what new tabs open: quota exceeded/);
    assert.equal(t.$('newtab-status').classList.contains('status-error'), true);
    assert.equal(t.page.savedTarget, 'auto');
  });

  it('refuses a value that is not a choice', async () => {
    const t = await setup();
    assert.equal(await t.page.saveTarget('elsewhere'), null);
    assert.deepEqual(t.storage.calls.set, []);
  });

  it('saves a valid Pages site address, normalised', async () => {
    const t = await setup({ storage: createStorage({ target: 'pages' }) });
    t.$('pages-url').value = '  https://Me.GitHub.io/portly-pages  ';
    t.$('pages-form').dispatchEvent(new t.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    assert.deepEqual(t.storage.data, { target: 'pages', pagesUrl: 'https://me.github.io/portly-pages/' });
    assert.equal(t.$('pages-url').value, 'https://me.github.io/portly-pages/');
    assert.equal(t.$('pages-url-error').hidden, true);
    assert.equal(t.$('newtab-status').textContent, 'Saved. New tabs will open the Pages site, https://me.github.io/portly-pages/.');
    assert.equal(pagesText(t), 'https://me.github.io/portly-pages/');
  });

  it('accepts http only for a build on this PC', async () => {
    const t = await setup({ storage: createStorage({ target: 'local' }) });
    t.$('pages-url').value = 'http://127.0.0.1:4173/';
    assert.equal(await t.page.savePagesUrl(), 'http://127.0.0.1:4173/');
    assert.equal(t.$('newtab-status').textContent, 'Saved. New tabs use this address once you choose "The Pages site" above.');
  });

  for (const value of [
    'me.github.io',
    '//me.github.io/',
    'http://me.github.io/',
    'ftp://me.github.io/',
    'javascript:alert(1)',
    'https://user:pass@me.github.io/',
    'https://me.github.io/?x=1',
    'https://me.github.io/#/',
    'http://192.168.1.10:4173/',
  ]) {
    it(`rejects ${JSON.stringify(value)} without touching storage`, async () => {
      const t = await setup({ storage: createStorage({ pagesUrl: 'https://me.github.io/' }) });
      t.$('pages-url').value = value;
      assert.equal(await t.page.savePagesUrl(), null);
      assert.deepEqual(t.storage.calls.set, []);
      assert.deepEqual(t.storage.calls.remove, []);
      assert.equal(t.$('pages-url-error').hidden, false);
      assert.equal(t.$('pages-url-error').textContent, PAGES_URL_ERROR);
      assert.equal(t.$('pages-url').getAttribute('aria-invalid'), 'true');
      assert.equal(t.document.activeElement, t.$('pages-url'));
      assert.equal(t.page.savedPagesUrl, 'https://me.github.io/');
    });
  }

  it('clears the address error once the input becomes valid', async () => {
    const t = await setup();
    t.$('pages-url').value = 'nope';
    await t.page.savePagesUrl();
    t.$('pages-url').value = 'https://me.github.io/';
    t.$('pages-url').dispatchEvent(new t.window.Event('input', { bubbles: true }));
    assert.equal(t.$('pages-url-error').hidden, true);
    assert.equal(t.$('pages-url').hasAttribute('aria-invalid'), false);
  });

  it('an empty address (or "Use the address Portly reports") forgets the stored one', async () => {
    const t = await setup({ storage: createStorage({ target: 'pages', pagesUrl: 'https://other.example/', ...known(SITE) }) });
    t.$('pages-reset').click();
    await flush();
    assert.deepEqual(t.storage.data, { target: 'pages', ...known(SITE) });
    assert.equal(t.$('pages-url').value, '');
    assert.equal(t.page.savedPagesUrl, null);
    assert.equal(pagesText(t), SITE);
    assert.equal(t.$('newtab-status').textContent, `Saved. New tabs will open the Pages site, ${SITE}.`);

    const auto = await setup({ storage: createStorage({ pagesUrl: 'https://other.example/' }) });
    auto.$('pages-url').value = '   ';
    assert.equal(await auto.page.savePagesUrl(), '');
    assert.deepEqual(auto.storage.data, {});
    assert.equal(auto.$('newtab-status').textContent, 'Saved. "The Pages site" will use the address Portly on this PC reports.');
  });

  it('reports storage failures for the address', async () => {
    const t = await setup({ storage: createStorage({}, { failSet: true }) });
    t.$('pages-url').value = 'https://me.github.io/';
    assert.equal(await t.page.savePagesUrl(), null);
    assert.match(t.$('newtab-status').textContent, /Couldn't save the Pages site address: quota exceeded/);
    assert.equal(t.page.savedPagesUrl, null);
  });

  it('Test connection records the Pages site Portly names and shows it', async () => {
    const t = await setup({ fetch: createFetch(() => jsonResponse({ ...HEALTH_BODY, pagesUrl: SITE })) });
    assert.equal(await t.page.test().then((r) => r.ok), true);
    assert.equal(t.$('status').textContent, `Portly is running on port 5757 (version 0.1.0). Its Pages site: ${SITE}.`);
    assert.deepEqual(t.storage.data, known(SITE));
    assert.equal(autoText(t), `its Pages site, ${SITE}`);
    assert.equal(t.$('pages-url').placeholder, SITE);

    const none = await setup({ fetch: createFetch(() => jsonResponse({ ...HEALTH_BODY, pagesUrl: null })) });
    await none.page.test();
    assert.equal(
      none.$('status').textContent,
      'Portly is running on port 5757 (version 0.1.0). It has no Pages site (PORTLY_PAGES_URL is not set).',
    );
    assert.equal(autoText(none), 'Portly itself, http://localhost:5757');
  });

  it('fails loudly if options.html loses a choice', () => {
    const window = loadPage('options.html');
    window.document.querySelector('input[name="target"][value="local"]').remove();
    assert.throws(
      () => createOptionsPage({ document: window.document, storage: createStorage(), fetch: createFetch(ok) }),
      /missing the "local" choice/,
    );
    window.close();
  });
});

describe('options page: launcher', () => {
  const PONG = { response: { ok: true, state: 'pong', version: 1 } };

  it('shows the extension ID', async () => {
    const t = await setup({ runtime: createNativeRuntime(PONG) });
    assert.equal(t.$('extension-id').textContent, PINNED_EXTENSION_ID);
    assert.equal(t.$('test-launcher').disabled, false);
    assert.equal(t.$('launcher-status').textContent, '');
  });

  it('Test launcher pings the host and reports it installed', async () => {
    const t = await setup({ runtime: createNativeRuntime(PONG) });
    t.$('test-launcher').click();
    assert.equal(t.$('test-launcher').disabled, true, 'busy while waiting');
    assert.equal(t.$('launcher-status').textContent, 'Asking the launcher…');
    await flush();
    assert.deepEqual(t.runtime.calls, [{ host: 'com.portly.launcher', message: { action: 'ping' } }]);
    assert.equal(t.$('launcher-status').textContent, 'The launcher is installed and answering. New tabs can start Portly.');
    assert.equal(t.$('launcher-status').classList.contains('status-ok'), true);
    assert.equal(t.$('test-launcher').disabled, false);
    assert.deepEqual(t.storage.calls.set, [], 'testing never saves anything');
  });

  it('reports a launcher that is not installed', async () => {
    const t = await setup({ runtime: createNativeRuntime({ error: NATIVE_ERRORS.notFound }) });
    const result = await t.page.testLauncher();
    assert.equal(result.status, 'not_installed');
    assert.equal(
      t.$('launcher-status').textContent,
      "The launcher isn't installed. Run scripts\\install-autostart.ps1 in your Portly folder (see docs\\setup\\autostart.md).",
    );
    assert.equal(t.$('launcher-status').classList.contains('status-error'), true);
  });

  it('reports an ID mismatch (forbidden or bad_origin) with this extension ID', async () => {
    for (const reply of [{ error: NATIVE_ERRORS.forbidden }, { response: { ok: false, state: 'error', error: 'bad_origin' } }]) {
      const t = await setup({ runtime: createNativeRuntime(reply) });
      const result = await t.page.testLauncher();
      assert.equal(result.status, 'mismatch');
      assert.equal(
        t.$('launcher-status').textContent,
        `The launcher is installed but doesn't accept this extension's ID (${PINNED_EXTENSION_ID}). Run scripts\\install-autostart.ps1 again so it allows this ID.`,
      );
    }
  });

  it('reports a launcher that is registered but broken', async () => {
    for (const error of [NATIVE_ERRORS.exited, NATIVE_ERRORS.failedToStart]) {
      const t = await setup({ runtime: createNativeRuntime({ error }) });
      const result = await t.page.testLauncher();
      assert.equal(result.status, 'broken');
      assert.match(t.$('launcher-status').textContent, /^The launcher is installed but didn't answer properly: /);
      assert.ok(t.$('launcher-status').textContent.includes(error.replace(/\.$/, '')));
    }
  });

  it('gives up on a launcher that never answers', async () => {
    const timers = createTimers();
    const t = await setup({ runtime: createNativeRuntime('hang'), timers });
    const pending = t.page.testLauncher();
    await timers.advance(10000);
    assert.equal((await pending).status, 'broken');
    assert.match(t.$('launcher-status').textContent, /did not answer in time/);
    assert.equal(t.$('test-launcher').disabled, false);
  });

  it('ignores a second click while a ping is running', async () => {
    const t = await setup({ runtime: createNativeRuntime('hang') });
    void t.page.testLauncher();
    assert.equal(await t.page.testLauncher(), null);
    assert.equal(t.runtime.calls.length, 1);
    t.runtime.answer({ response: { ok: true, state: 'pong', version: 1 } });
    await flush();
  });

  it('flags a launcher speaking another protocol version', () => {
    const { message, tone } = describePing({ status: 'installed', version: 2, detail: '' }, PINNED_EXTENSION_ID);
    assert.equal(tone, 'error');
    assert.match(message, /protocol version 2 \(this extension expects 1\)/);
  });

  it('no ID warning for the pinned ID', async () => {
    const t = await setup({ runtime: createNativeRuntime(PONG) });
    assert.equal(t.$('extension-id-note').hidden, true);
    assert.equal(t.$('extension-id-note').textContent, '');
  });

  it('warns when the browser still runs the extension under its old ID', async () => {
    const runtime = createNativeRuntime({ error: NATIVE_ERRORS.forbidden });
    runtime.id = OLD_PATH_EXTENSION_ID;
    const t = await setup({ runtime });
    assert.equal(t.$('extension-id').textContent, OLD_PATH_EXTENSION_ID);
    assert.equal(t.$('extension-id-note').hidden, false);
    assert.match(t.$('extension-id-note').textContent, new RegExp(`isn't the extension's fixed ID \\(${PINNED_EXTENSION_ID}\\)`));
    assert.match(t.$('extension-id-note').textContent, /Remove .* Load unpacked/);

    const result = await t.page.testLauncher();
    assert.equal(result.status, 'mismatch');
    assert.equal(
      t.$('launcher-status').textContent,
      `The launcher only answers this extension's fixed ID (${PINNED_EXTENSION_ID}), but the browser still runs it under its old ID (${OLD_PATH_EXTENSION_ID}). On chrome://extensions (or edge://extensions), click Remove on Portly New Tab, then Load unpacked and select the extension folder again.`,
    );
  });

  it('old ID and no launcher: reload first, then install', () => {
    const { message, tone } = describePing({ status: 'not_installed', version: null, detail: '' }, OLD_PATH_EXTENSION_ID);
    assert.equal(tone, 'error');
    assert.match(message, /Load unpacked and select the extension folder again, then run scripts\\install-autostart\.ps1\.$/);
    assert.equal(describeExtensionId(null), '');
    assert.equal(describeExtensionId('unknown'), '');
  });

  it('without native messaging the button is disabled and says why', async () => {
    const t = await setup();
    assert.equal(t.$('extension-id').textContent, 'unknown');
    assert.equal(t.$('test-launcher').disabled, true);
    assert.equal(t.$('launcher-status').textContent, LAUNCHER_UNAVAILABLE);
    assert.equal(await t.page.testLauncher(), null);
  });
});
