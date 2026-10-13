#!/usr/bin/env node
/**
 * Runs the native messaging host's tests (native-host/launcher.mjs: framing, origin and request
 * checks, health check, schtasks mapping, and an end-to-end run through launcher.cmd) with
 * node:test. Never runs, registers or changes a scheduled task and never writes the registry.
 * Also run by scripts/check-scripts.ps1.
 *
 *   node scripts/check-native-host.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(repoRoot, 'scripts', 'tests');

const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join('scripts', 'tests', name));

if (files.length === 0) {
  process.stderr.write(`No native host tests found in ${testDir}\n`);
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
