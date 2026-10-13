/**
 * Weather widget settings (§10.8 Weather): location search (debounced `/api/weather/geocode`),
 * "Use as default location" (PATCH settings.weather.defaultLocation), device location, which
 * forecasts to show and the temperature unit. Changes go to the dialog draft via `onChange`;
 * only "Use as default location" / "Clear default" save immediately (they are global).
 */
import { useState, type ReactNode } from 'react';
import { Globe, LocateFixed, MapPin, Search, Star, X } from 'lucide-react';
import type { GeoPlace } from '@portly/shared';
import { useSettings } from '../../api/settings.ts';
import { GEOCODE_MAX_CHARS, GEOCODE_MIN_CHARS, normalizeGeocodeQuery, useGeocode, useSetDefaultLocation } from '../../api/weather.ts';
import { useDebouncedCallback } from '../../lib/useDebouncedCallback.ts';
import { Badge } from '../../ui/Badge.tsx';
import { Button, IconButton } from '../../ui/Button.tsx';
import { Field } from '../../ui/Field.tsx';
import { Spinner } from '../../ui/Spinner.tsx';
import { errorMessage, toastUndo } from '../../ui/toast.ts';
import { SegmentedControl, Switch } from '../../ui/Toggles.tsx';
import type { WidgetSettingsProps } from '../types.ts';
import type { WeatherConfig } from './index.ts';
import { placeSubtitle, samePlace } from './location.ts';
import { SearchCombobox } from './SearchCombobox.tsx';
import styles from './Settings.module.css';

export const GEOCODE_DEBOUNCE_MS = 300;

export default function WeatherSettings({ value, onChange }: WidgetSettingsProps<WeatherConfig>) {
  const settings = useSettings();
  const defaultLocation = settings.data?.weather.defaultLocation ?? null;
  const settingsUnit = settings.data?.general.temperatureUnit ?? 'C';
  const { setDefaultLocation, isPending: savingDefault } = useSetDefaultLocation();

  const update = (patch: Partial<WeatherConfig>) => onChange({ ...value, ...patch });

  const makeDefault = async (place: GeoPlace) => {
    const previous = defaultLocation;
    try {
      await setDefaultLocation(place);
      toastUndo(`${place.name} is now your default location.`, {
        onUndo: async () => {
          await setDefaultLocation(previous);
        },
      });
    } catch {
      // useUpdateSettings rolled back and showed a toast.
    }
  };

  const clearDefault = async () => {
    const previous = defaultLocation;
    try {
      await setDefaultLocation(null);
      toastUndo('Default location cleared.', {
        onUndo: async () => {
          await setDefaultLocation(previous);
        },
      });
    } catch {
      // Reported by useUpdateSettings.
    }
  };

  const isDefault = samePlace(value.location, defaultLocation);

  return (
    <div className={styles.stack}>
      <div data-settings-focus="location">
        <Field label="Location" help="Search for a city or town. Leave empty to use your default location.">
          <LocationSearch onSelect={(place) => update({ location: place })} />
        </Field>
      </div>

      {value.location ? (
        <div className={styles.placeCard} aria-label="Selected location" role="group">
          <MapPin aria-hidden="true" className={styles.placeCardIcon} />
          <div className={styles.placeCardText}>
            <p className={styles.placeCardName}>{value.location.name}</p>
            <p className={styles.placeCardMeta}>{placeMeta(value.location)}</p>
          </div>
          <div className={styles.placeCardActions}>
            {isDefault ? (
              <Badge tone="accent" icon={Star}>
                Default
              </Badge>
            ) : (
              <Button size="sm" icon={Star} loading={savingDefault} onClick={() => void makeDefault(value.location!)}>
                Use as default location
              </Button>
            )}
            <IconButton size="sm" icon={X} aria-label={`Remove ${value.location.name}`} onClick={() => update({ location: null })} />
          </div>
        </div>
      ) : (
        <p className={styles.note}>
          {defaultLocation ? (
            <>
              Using your default location, <strong>{describe(defaultLocation)}</strong>.
            </>
          ) : value.useDeviceLocation ? (
            "Using this device's location."
          ) : (
            'No location yet. Search above, or use this device’s location.'
          )}
        </p>
      )}

      {defaultLocation && !value.location ? (
        <div>
          <Button size="sm" variant="ghost" icon={X} loading={savingDefault} onClick={() => void clearDefault()}>
            Clear default location
          </Button>
        </div>
      ) : null}

      <Switch
        label={
          <span className={styles.labelWithIcon}>
            <LocateFixed aria-hidden="true" />
            Use this device's location
          </span>
        }
        description={
          defaultLocation && !value.location && value.useDeviceLocation
            ? 'Your default location takes precedence. Clear it to use this device.'
            : 'Used when neither this widget nor your default has a location. Your browser asks first.'
        }
        checked={value.useDeviceLocation}
        onCheckedChange={(checked) => update({ useDeviceLocation: checked })}
      />

      <div className={styles.group} role="group" aria-labelledby="hb-weather-show">
        <p id="hb-weather-show" className={styles.groupLabel}>
          Show
        </p>
        <Switch
          label="Hourly forecast"
          description="The next 24 hours (medium and large sizes)."
          checked={value.show.hourly}
          onCheckedChange={(hourly) => update({ show: { ...value.show, hourly } })}
        />
        <Switch
          label="7-day forecast"
          description="Daily highs and lows (large size, or medium without the hourly strip)."
          checked={value.show.daily}
          onCheckedChange={(daily) => update({ show: { ...value.show, daily } })}
        />
      </div>

      <Field label="Temperature unit" help="Wind and precipitation follow General settings.">
        <SegmentedControl
          value={value.units}
          onValueChange={(units) => update({ units })}
          options={[
            { value: 'inherit', label: `Default (°${settingsUnit})` },
            { value: 'C', label: '°C' },
            { value: 'F', label: '°F' },
          ]}
        />
      </Field>
    </div>
  );
}

function describe(place: GeoPlace): string {
  return [place.name, placeSubtitle(place)].filter(Boolean).join(', ');
}

function placeMeta(place: GeoPlace): string {
  const coords = `${place.lat.toFixed(2)}, ${place.lon.toFixed(2)}`;
  return [placeSubtitle(place), coords].filter(Boolean).join(' · ');
}

/** Debounced place search with keyboard-navigable results. */
export function LocationSearch({ onSelect }: { onSelect(place: GeoPlace): void }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const debouncedSetQuery = useDebouncedCallback(setQuery, GEOCODE_DEBOUNCE_MS);
  const results = useGeocode(query);

  // What is searched: the normalized text, cut to the server's 100-character limit (the same
  // string is compared below, so an over-long entry still settles instead of "Searching…").
  const searchText = (value: string) => normalizeGeocodeQuery(value).slice(0, GEOCODE_MAX_CHARS).trim();
  const typed = searchText(text);
  const open = typed.length >= GEOCODE_MIN_CHARS;
  const settled = query.toLowerCase() === typed.toLowerCase();
  // While typing, the previous results stay visible until the new ones arrive.
  const places = open && query !== '' && results.data ? results.data : [];

  const onValueChange = (next: string) => {
    setText(next);
    const nextQuery = searchText(next);
    if (nextQuery.length < GEOCODE_MIN_CHARS) {
      debouncedSetQuery.cancel();
      setQuery('');
    } else {
      debouncedSetQuery(nextQuery);
    }
  };

  let status: ReactNode = null;
  if (open && places.length === 0) {
    if (!settled || results.isFetching) {
      status = (
        <span className={styles.statusRow}>
          <Spinner size={14} /> Searching…
        </span>
      );
    } else if (results.isError) {
      status = `Search failed: ${errorMessage(results.error, 'the weather service is unavailable.')}`;
    } else if (results.data && results.data.length === 0) {
      status = `No places found for “${typed}”.`;
    }
  }

  return (
    <SearchCombobox<GeoPlace>
      value={text}
      onValueChange={onValueChange}
      items={places}
      open={open}
      status={status}
      icon={Search}
      placeholder="Search for a city"
      getKey={(place) => `${place.name}|${place.admin1 ?? ''}|${place.country ?? ''}|${place.lat}|${place.lon}`}
      getLabel={(place) => describe(place)}
      renderItem={(place) => (
        <span className={styles.optionBody}>
          <MapPin aria-hidden="true" className={styles.optionIcon} />
          <span className={styles.optionText}>
            <span className={styles.optionName}>{place.name}</span>
            <span className={styles.optionMeta}>{placeSubtitle(place) || `${place.lat.toFixed(2)}, ${place.lon.toFixed(2)}`}</span>
          </span>
          {place.timezone ? (
            <span className={styles.optionAside}>
              <Globe aria-hidden="true" />
              {place.timezone}
            </span>
          ) : null}
        </span>
      )}
      onSelect={(place) => {
        onSelect(place);
        setText('');
        debouncedSetQuery.cancel();
        setQuery('');
      }}
    />
  );
}
