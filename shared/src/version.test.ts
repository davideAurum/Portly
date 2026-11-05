import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_VERSION_LENGTH, compareVersions, isNewerVersion } from './version.ts';

const ORDER = JSON.parse(readFileSync(path.join(import.meta.dirname, '__fixtures__', 'version-order.json'), 'utf8')) as {
  ascending: string[];
  equal: [string, string][];
  invalid: string[];
};

describe('compareVersions', () => {
  it('orders the table: every earlier entry is older than every later one', () => {
    ORDER.ascending.forEach((a, i) => {
      ORDER.ascending.forEach((b, j) => {
        expect(Math.sign(compareVersions(a, b) ?? Number.NaN), `${a} against ${b}`).toBe(Math.sign(i - j));
      });
    });
  });

  it('ranks equal versions the same, whatever their build metadata', () => {
    for (const [a, b] of ORDER.equal) expect(compareVersions(a, b), `${a} against ${b}`).toBe(0);
  });

  it('reads what is not a well-formed version as no version', () => {
    for (const bad of ORDER.invalid) {
      expect(compareVersions(bad, '1.2.3'), bad).toBeNull();
      expect(compareVersions('1.2.3', bad), bad).toBeNull();
    }
  });

  it('reads nothing longer than the cap', () => {
    const longest = `1.2.3-${'a'.repeat(MAX_VERSION_LENGTH - 6)}`;
    expect(longest).toHaveLength(MAX_VERSION_LENGTH);
    expect(compareVersions(longest, '1.2.3')).toBeLessThan(0);
    expect(compareVersions(`${longest}a`, '1.2.3')).toBeNull();
    expect(compareVersions(`1.2.3+${'a.'.repeat(5000)}`, '1.2.3')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('is true only for a certainly newer version', () => {
    expect(isNewerVersion('0.2.0-alpha.10', '0.2.0-alpha.9')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.2.0-alpha.9')).toBe(true);
    expect(isNewerVersion('0.2.0-alpha.9', '0.2.0-alpha.10')).toBe(false);
    expect(isNewerVersion('0.2.0-alpha.7', '0.2.0-alpha.7')).toBe(false);
  });

  it('never counts a version it cannot read as newer', () => {
    for (const bad of ORDER.invalid) {
      expect(isNewerVersion(bad, '1.0.0'), bad).toBe(false);
      expect(isNewerVersion('1.0.0', bad), bad).toBe(false);
    }
  });
});
