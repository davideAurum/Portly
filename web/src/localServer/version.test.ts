/**
 * Version order for the "server is older than the site" notice: semver precedence with
 * prereleases, and untrusted text that must read as no version at all.
 */
import { describe, expect, it } from 'vitest';
import { compareVersions, isServerBehind } from './version.ts';

describe('compareVersions', () => {
  it.each([
    ['0.2.0-alpha.9', '0.2.0-alpha.10'],
    ['0.2.0-alpha.6', '0.2.0-alpha.7'],
    ['0.2.0-alpha.7', '0.2.0'],
    ['0.2.0', '0.2.1-alpha.1'],
    ['0.2.0-alpha.7', '0.2.0-beta.1'],
    ['0.9.0', '0.10.0'],
    ['0.99.99', '1.0.0'],
    ['1.2.3', '1.2.10'],
    ['1.0.0-1', '1.0.0-alpha'],
    ['1.0.0-2', '1.0.0-10'],
    ['1.0.0-Beta', '1.0.0-alpha'],
  ])('%s is older than %s', (older, newer) => {
    expect(compareVersions(older, newer)).toBeLessThan(0);
    expect(compareVersions(newer, older)).toBeGreaterThan(0);
  });

  it('follows the order of the semver specification', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (const [index, version] of ordered.entries()) {
      for (const later of ordered.slice(index + 1)) {
        expect(compareVersions(version, later)).toBeLessThan(0);
        expect(compareVersions(later, version)).toBeGreaterThan(0);
      }
    }
  });

  it('ranks equal versions the same, whatever their build metadata', () => {
    expect(compareVersions('0.2.0-alpha.7', '0.2.0-alpha.7')).toBe(0);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.0-alpha.7+abc', '0.2.0-alpha.7+def.1')).toBe(0);
  });

  it.each([
    '',
    '1',
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    ' 1.2.3',
    '1.2.3 ',
    '1.2.3\n',
    'latest',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3-alpha.',
    '1.2.3+',
    '1.2.3+a..b',
    '1.2.3-é',
    '١.٢.٣',
    '-1.2.3',
    '1.2.x',
    '<img src=x onerror=alert(1)>',
    '9007199254740992.0.0',
    '1.0.0-9007199254740992',
    '99999999999999999999.0.0',
    `1.2.3-${'a'.repeat(40)}`,
    `1.2.3+${'a.'.repeat(5000)}`,
  ])('reads %j as no version', (text) => {
    expect(compareVersions(text, '1.2.3')).toBeNull();
    expect(compareVersions('1.2.3', text)).toBeNull();
  });

  it('reads the longest version allowed', () => {
    const longest = `1.2.3-${'a'.repeat(34)}`;
    expect(longest).toHaveLength(40);
    expect(compareVersions(longest, '1.2.3')).toBeLessThan(0);
  });
});

describe('isServerBehind', () => {
  it('is true only for a server older than the site', () => {
    expect(isServerBehind('0.2.0-alpha.6', '0.2.0-alpha.7')).toBe(true);
    expect(isServerBehind('0.2.0-alpha.9', '0.2.0-alpha.10')).toBe(true);
    expect(isServerBehind('0.2.0-alpha.7', '0.2.0-alpha.7')).toBe(false);
    expect(isServerBehind('0.2.0-alpha.10', '0.2.0-alpha.9')).toBe(false);
    expect(isServerBehind('0.2.0', '0.2.0-alpha.7')).toBe(false);
  });

  it('says no when either version cannot be read', () => {
    expect(isServerBehind('garbage', '0.2.0-alpha.7')).toBe(false);
    expect(isServerBehind('', '0.2.0-alpha.7')).toBe(false);
    expect(isServerBehind('0.2.0-alpha.6', 'garbage')).toBe(false);
  });

  it("takes a server's 0.0.0 as a version it could not read", () => {
    expect(isServerBehind('0.0.0', '0.2.0-alpha.7')).toBe(false);
  });
});
