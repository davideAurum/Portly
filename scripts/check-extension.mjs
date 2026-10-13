#!/usr/bin/env node
/**
 * Runs the new-tab extension's checks (manifest, pages, icons, new-tab and options logic with
 * mocked fetch/chrome.storage) with node:test. The extension is plain JS with no build step, so
 * it is not part of the vitest projects.
 *
 *   node scripts/check-extension.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(repoRoot, 'extension', 'test');

const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join('extension', 'test', name));

if (files.length === 0) {
  process.stderr.write(`No extension tests found in ${testDir}\n`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: repoRoot,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  process.stderr.write(`Could not run node --test: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
