/** Mirrors the zone part of server/src/modules/calendar/providers/providers.test.ts for the static port. */
import { describe, expect, it } from 'vitest';
import { WINDOWS_ZONE_COUNT, ianaToWindows, resolveTimeZoneName, windowsToIana } from './windowsZones.ts';

describe('windows zones', () => {
  it('bundles the CLDR windowsZones table', () => {
    expect(WINDOWS_ZONE_COUNT).toBeGreaterThan(130);
    expect(windowsToIana('W. Europe Standard Time')).toBe('Europe/Berlin');
    expect(windowsToIana('eastern standard time')).toBe('America/New_York');
    expect(ianaToWindows('Europe/Amsterdam')).toBe('W. Europe Standard Time');
    // Browsers report current IANA names; CLDR lists the legacy ones.
    expect(ianaToWindows('Asia/Kolkata')).toBe('India Standard Time');
    expect(ianaToWindows('Europe/Kyiv')).toBe('FLE Standard Time');
    expect(ianaToWindows('UTC')).toBe('UTC');
    expect(ianaToWindows('Nowhere/Special')).toBeNull();
  });

  it('resolves calendar TZIDs: IANA, Windows, vendor-prefixed, quoted', () => {
    expect(resolveTimeZoneName('Europe/Paris')).toBe('Europe/Paris');
    expect(resolveTimeZoneName('/mozilla.org/20050126_1/Europe/Paris')).toBe('Europe/Paris');
    expect(resolveTimeZoneName('"Tokyo Standard Time"')).toBe('Asia/Tokyo');
    expect(resolveTimeZoneName('Z')).toBe('UTC');
    expect(resolveTimeZoneName('Nowhere/Special')).toBeNull();
    expect(resolveTimeZoneName(null)).toBeNull();
  });
});
