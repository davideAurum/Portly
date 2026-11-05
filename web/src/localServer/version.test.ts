/**
 * The "server is older than the site" notice. The version order itself is tested in
 * `shared/src/version.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { isServerBehind } from './version.ts';

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
