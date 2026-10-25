/**
 * Nominatim fixtures (a copy of server/src/modules/weather/__fixtures__/nominatim.ts) modelled on
 * the documented response of
 * `GET https://nominatim.openstreetmap.org/reverse?lat=&lon=&format=jsonv2&zoom=10&addressdetails=1`.
 */

/** City-level answer near 43.61, -116.20. */
export function boiseReverse(): Record<string, unknown> {
  return {
    place_id: 1234567,
    licence: 'Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright',
    osm_type: 'relation',
    osm_id: 7654321,
    lat: '43.6106824',
    lon: '-116.2024326',
    category: 'boundary',
    type: 'administrative',
    place_rank: 16,
    importance: 0.62,
    addresstype: 'city',
    name: 'Boise',
    display_name: 'Boise, Ada County, Idaho, United States',
    address: {
      city: 'Boise',
      county: 'Ada County',
      state: 'Idaho',
      'ISO3166-2-lvl4': 'US-AL',
      country: 'United States',
      country_code: 'us',
    },
    boundingbox: ['33.3', '33.7', '-87.1', '-86.5'],
  };
}

/** Nothing at the coordinates (open sea). */
export function unableToGeocode(): Record<string, unknown> {
  return { error: 'Unable to geocode' };
}
