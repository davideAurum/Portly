import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@portly/shared';
import { firstRunGeneralPatch, localeDefaults } from './localeDefaults.ts';

describe('locale defaults on first run (UX-2)', () => {
  it.each([
    ['en-US', { weekStartsOn: 0, temperatureUnit: 'F', windUnit: 'mph', precipUnit: 'in' }],
    ['en', { weekStartsOn: 0, temperatureUnit: 'F', windUnit: 'mph', precipUnit: 'in' }],
    ['en-GB', { weekStartsOn: 1, temperatureUnit: 'C', windUnit: 'mph', precipUnit: 'mm' }],
    ['de-DE', { weekStartsOn: 1, temperatureUnit: 'C', windUnit: 'kmh', precipUnit: 'mm' }],
    ['fr-CA', { weekStartsOn: 0, temperatureUnit: 'C', windUnit: 'kmh', precipUnit: 'mm' }],
    ['ar-EG', { weekStartsOn: 6, temperatureUnit: 'C', windUnit: 'kmh', precipUnit: 'mm' }],
  ])('%s → %j', (language, expected) => {
    expect(localeDefaults(language)).toEqual(expected);
  });

  it('only changes settings that are still the schema defaults', () => {
    const general = defaultSettings().general;
    expect(firstRunGeneralPatch(general, 'en-US')).toEqual({ weekStartsOn: 0, temperatureUnit: 'F', windUnit: 'mph', precipUnit: 'in' });
    expect(firstRunGeneralPatch(general, 'de-DE')).toBeNull();
    expect(firstRunGeneralPatch({ ...general, temperatureUnit: 'F' }, 'de-DE')).toBeNull();
    expect(firstRunGeneralPatch({ ...general, windUnit: 'ms' }, 'en-US')).toBeNull();
    expect(firstRunGeneralPatch(general, 'not a locale')).toBeNull();
  });
});
