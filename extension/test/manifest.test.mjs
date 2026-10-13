/**
 * Static checks for the unpacked extension (ARCHITECTURE §11): manifest fields, the pages' CSP
 * compatibility (no inline scripts or handlers), every referenced file exists, and the icons
 * are valid PNGs in sync with tools/generate-icons.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { ICON_SIZES, decodePng, iconIsCurrent } from '../tools/generate-icons.mjs';
import { ACTION_TITLE } from '../lib/add-page.js';
import { EXTENSION_DIR, loadPage, readExtensionFile } from './helpers.mjs';

const manifest = JSON.parse(readExtensionFile('manifest.json'));
const rootPackage = JSON.parse(fs.readFileSync(new URL('../package.json', EXTENSION_DIR), 'utf8'));

function exists(relativePath) {
  return fs.existsSync(new URL(relativePath, EXTENSION_DIR));
}

/** Chrome version strings ("1.2.3") compared numerically. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

function directives(policy) {
  const map = new Map();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}

describe('manifest.json', () => {
  it('is a Manifest V3 extension, never versioned behind the app', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(typeof manifest.name, 'string');
    assert.ok(manifest.name.length > 0 && manifest.name.length <= 75);
    assert.ok(manifest.description.length <= 132, 'Chrome limits descriptions to 132 characters');
    assert.match(manifest.version, /^\d+(\.\d+){0,3}$/);
    assert.ok(manifest.version.split('.').every((part) => Number(part) <= 65535), 'Chrome version parts are 0-65535');
    assert.ok(compareVersions(manifest.version, '0.2.0') >= 0, 'launcher (native messaging) support starts at 0.2.0');
    assert.ok(compareVersions(manifest.version, '0.3.0') >= 0, 'the Pages site target (and warm-up messages) start at 0.3.0');
    assert.ok(compareVersions(manifest.version, '0.4.0') >= 0, 'the "Add this page" toolbar button starts at 0.4.0');
    assert.ok(compareVersions(manifest.version, '0.5.0') >= 0, 'following Portly on this PC (the "auto" target) starts at 0.5.0');
    assert.ok(
      compareVersions(manifest.version, rootPackage.version.replace(/[-+].*$/, '')) >= 0,
      'the extension version is never older than the app version in package.json',
    );
  });

  it('overrides only the new tab page, with newtab.html', () => {
    assert.deepEqual(manifest.chrome_url_overrides, { newtab: 'newtab.html' });
    assert.ok(exists('newtab.html'));
  });

  it('asks for exactly storage + nativeMessaging + activeTab + http://localhost/* (any port)', () => {
    assert.deepEqual(manifest.permissions, ['storage', 'nativeMessaging', 'activeTab']);
    assert.deepEqual(manifest.host_permissions, ['http://localhost/*']);
    assert.equal(manifest.optional_permissions, undefined);
    assert.equal(manifest.optional_host_permissions, undefined);
  });

  it('has an options page and nothing that runs in or talks to web pages', () => {
    assert.equal(manifest.options_page, 'options.html');
    assert.ok(exists('options.html'));
    for (const key of ['content_scripts', 'externally_connectable', 'web_accessible_resources', 'options_ui']) {
      assert.equal(manifest[key], undefined, `${key} must not be declared`);
    }
  });

  it('has a toolbar button ("Add this page to Portly") with no popup', () => {
    assert.deepEqual(manifest.action, {
      default_title: ACTION_TITLE,
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    });
    assert.equal(manifest.browser_action, undefined);
    assert.equal(manifest.page_action, undefined);
  });

  it('has a module service worker, background.js (no persistent background page)', () => {
    assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });
    assert.ok(exists('background.js'));
  });

  it('pins its ID with a "key" and has no update_url (it is loaded unpacked)', () => {
    assert.equal(typeof manifest.key, 'string');
    assert.equal(manifest.update_url, undefined);
  });

  it('declares every icon size and the files exist', () => {
    assert.deepEqual(Object.keys(manifest.icons).map(Number), ICON_SIZES);
    for (const [size, file] of Object.entries(manifest.icons)) {
      assert.equal(file, `icons/icon-${size}.png`);
      const png = decodePng(fs.readFileSync(new URL(file, EXTENSION_DIR)));
      assert.equal(png.width, Number(size));
      assert.equal(png.height, Number(size));
    }
  });

  it('tightens the extension-page CSP without ever allowing inline or eval', () => {
    const policy = manifest.content_security_policy.extension_pages;
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|wasm-unsafe-eval|https?:\/\/(?!localhost)/);
    const d = directives(policy);
    assert.deepEqual(d.get('script-src'), ["'self'"]);
    assert.deepEqual(d.get('object-src'), ["'none'"]);
    assert.deepEqual(d.get('default-src'), ["'self'"]);
    assert.deepEqual(d.get('connect-src'), ['http://localhost:*']);
    assert.deepEqual(d.get('base-uri'), ["'none'"]);
  });
});

describe('extension pages', () => {
  for (const file of ['newtab.html', 'options.html']) {
    it(`${file} has no inline scripts, inline handlers or javascript: URLs`, () => {
      const window = loadPage(file);
      const doc = window.document;
      const scripts = [...doc.querySelectorAll('script')];
      assert.equal(scripts.length, 1);
      assert.equal(scripts[0].getAttribute('type'), 'module');
      assert.equal(scripts[0].textContent.trim(), '');
      assert.equal(scripts[0].getAttribute('src'), file.replace('.html', '.js'));
      assert.equal(doc.querySelectorAll('[style]').length, 0, 'no inline styles (style-src self)');
      assert.equal(doc.querySelectorAll('style').length, 0);
      for (const el of doc.querySelectorAll('*')) {
        for (const attr of el.attributes) {
          assert.doesNotMatch(attr.name, /^on/i, `${file}: inline handler ${attr.name}`);
          assert.doesNotMatch(attr.value, /^\s*javascript:/i, `${file}: javascript: URL`);
        }
      }
      assert.ok(doc.title.length > 0, 'pages have a title');
      window.close();
    });

    it(`${file} only references files that exist in the extension`, () => {
      const window = loadPage(file);
      const refs = [...window.document.querySelectorAll('script[src], link[href], img[src], a[href]')].map(
        (el) => el.getAttribute('src') ?? el.getAttribute('href'),
      );
      assert.ok(refs.length > 0);
      for (const ref of refs) {
        assert.doesNotMatch(ref, /^[a-z][a-z0-9+.-]*:|^\/\//i, `${file}: external reference ${ref}`);
        assert.ok(exists(ref), `${file}: missing ${ref}`);
      }
      window.close();
    });
  }

  it('the entry scripts import only local modules', () => {
    for (const file of [
      'background.js',
      'newtab.js',
      'options.js',
      'lib/newtab-page.js',
      'lib/options-page.js',
      'lib/portly.js',
      'lib/launcher.js',
      'lib/warm-up.js',
    ]) {
      const source = readExtensionFile(file);
      for (const match of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
        assert.match(match[1], /^\.\.?\//, `${file} imports ${match[1]}`);
      }
      assert.doesNotMatch(source, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    }
  });
});

describe('unpacked folder', () => {
  it('has no names Chrome refuses to load (leading "_" is reserved) and no node_modules', () => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
        return [entry.name, ...(entry.isDirectory() ? walk(url) : [])];
      });
    const names = walk(EXTENSION_DIR);
    assert.ok(names.includes('manifest.json'));
    assert.deepEqual(names.filter((name) => name.startsWith('_') || name === 'node_modules'), []);
  });
});

describe('icons', () => {
  for (const size of ICON_SIZES) {
    it(`icons/icon-${size}.png matches tools/generate-icons.mjs`, () => {
      assert.ok(iconIsCurrent(size), 'run `node extension/tools/generate-icons.mjs` to regenerate');
    });
  }
});
