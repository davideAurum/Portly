/**
 * Weather widget (§10.8 Weather): current conditions, an hourly strip and a 7-day list from
 * Open-Meteo via `GET /api/weather`. Location: widget → default → device (see location.ts).
 * Sections depend on the size tier (layout.ts); container queries refine each tier. Every tier
 * shows the attribution link Open-Meteo's terms (CC BY 4.0) ask for next to its data.
 */
import type { CSSProperties } from 'react';
import { Droplets, LocateFixed, MapPin, MapPinOff, Navigation2, RefreshCw, Sunrise, Sunset, Umbrella, Wind } from 'lucide-react';
import { weatherCodeInfo, type GeneralSettings, type WeatherDay, type WeatherHour, type WeatherReport } from '@portly/shared';
import { useSettings } from '../../api/settings.ts';
import { useWeather } from '../../api/weather.ts';
import { WidgetActions, useWidgetFrame } from '../../grid/WidgetContext.tsx';
import { hourCycleFor, resolveLocale } from '../../lib/format.ts';
import { useNow } from '../../lib/useNow.ts';
import { Button } from '../../ui/Button.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ExternalLink } from '../../ui/ExternalLink.tsx';
import { QueryView, StaleIndicator, type QueryViewMeta } from '../../ui/ErrorState.tsx';
import { Skeleton } from '../../ui/Skeleton.tsx';
import type { WidgetProps } from '../types.ts';
import type { WeatherConfig } from './index.ts';
import { HOURLY_STRIP_HOURS, PRECIP_LABEL_MIN, weatherTier, type WeatherTier, isWideCompact } from './layout.ts';
import { allowLocationPrompt, needsDeviceLocation, placeSubtitle, resolveLocation, useDeviceLocation, type LocationSource } from './location.ts';
import { clockLabel, dayLabel, dayLongLabel, hourLabel, isDaylight, placeNow, upcomingDays, upcomingHours, type HourCycle, type LabelZone } from './time.ts';
import {
  compassPoint,
  compassWords,
  convertPrecip,
  convertTemp,
  convertWind,
  displayTempUnit,
  formatPercent,
  formatPrecip,
  formatTemp,
  formatWind,
} from './units.ts';
import { ScrollStrip } from './ScrollStrip.tsx';
import { WeatherIcon } from './WeatherIcon.tsx';
import styles from './Widget.module.css';

/** Data older than this shows "Updated … ago" even when the last refresh succeeded. */
const OLD_DATA_MS = 30 * 60 * 1000;

/** Open-Meteo's terms ask for a link to it next to wherever its data is shown. */
const OPEN_METEO_URL = 'https://open-meteo.com/';

export default function WeatherWidget({ config, setConfig, size }: WidgetProps<WeatherConfig>) {
  const frame = useWidgetFrame();
  const settings = useSettings();
  const defaultLocation = settings.data ? settings.data.weather.defaultLocation : settings.isError ? null : undefined;
  const base = { configLocation: config.location, useDeviceLocation: config.useDeviceLocation, defaultLocation };
  const device = useDeviceLocation(needsDeviceLocation(base));
  const resolved = resolveLocation({ ...base, device });
  const tier = weatherTier(size);
  // One-line states for short *or* narrow cards (DoD #5: renders at the 2×3 minimum).
  const compact = tier === 'compact' || size.w <= 2;
  /** Room for a single button only. */
  const oneAction = size.w <= 2;
  const place = resolved.status === 'ready' ? resolved.place : null;
  const query = useWeather(place);

  const setLocationAction = frame.canOpenSettings ? (
    <Button size="sm" variant="primary" icon={MapPin} onClick={() => frame.openSettings({ focus: 'location' })}>
      Set location
    </Button>
  ) : null;

  switch (resolved.status) {
    case 'loading':
      return <WeatherSkeleton tier={tier} />;
    case 'not-configured':
      return (
        <EmptyState
          icon={MapPin}
          compact={compact}
          title="Set a location"
          body="Search for a city, or let Portly use this device's location."
          action={
            <>
              {setLocationAction}
              {oneAction && setLocationAction ? null : (
                <Button
                  size="sm"
                  icon={LocateFixed}
                  onClick={() => {
                    allowLocationPrompt();
                    void setConfig({ useDeviceLocation: true });
                  }}
                >
                  Use my location
                </Button>
              )}
            </>
          }
        />
      );
    case 'locating':
      return (
        <div className={styles.status} role="status">
          <LocateFixed className={styles.statusIcon} aria-hidden="true" />
          <span>Finding your location…</span>
        </div>
      );
    case 'device-needs-permission':
      // A page load does not make the browser ask (it would on every new tab): the user does.
      return (
        <EmptyState
          icon={LocateFixed}
          compact={compact}
          title="Show weather for your location"
          body="Your browser asks before sharing it. Allow it for this site to skip this step, or choose a place instead."
          action={
            <>
              <Button size="sm" variant="primary" icon={LocateFixed} onClick={device.retry}>
                Use my location
              </Button>
              {oneAction ? null : setLocationAction}
            </>
          }
        />
      );
    case 'device-denied':
      return (
        <EmptyState
          icon={MapPinOff}
          compact={compact}
          title="Location access is blocked"
          body="Allow location access for Portly in your browser, or choose a place instead."
          action={
            <>
              {setLocationAction}
              {oneAction && setLocationAction ? null : (
                <Button size="sm" icon={RefreshCw} onClick={device.retry}>
                  Try again
                </Button>
              )}
            </>
          }
        />
      );
    case 'device-unavailable':
      return (
        <EmptyState
          icon={MapPinOff}
          compact={compact}
          title="Device location is unavailable"
          body="This browser can't share its location. Choose a place instead."
          action={setLocationAction}
        />
      );
    case 'device-error':
      return (
        <EmptyState
          icon={MapPinOff}
          compact={compact}
          title="Couldn't find your location"
          body={resolved.message}
          action={
            <>
              <Button size="sm" icon={RefreshCw} onClick={device.retry}>
                Retry
              </Button>
              {setLocationAction}
            </>
          }
        />
      );
    case 'ready':
      return (
        <QueryView query={query} skeleton={<WeatherSkeleton tier={tier} />} compact={compact}>
          {(report, meta) => (
            <WeatherView
              report={report}
              meta={meta}
              placeName={resolved.place.name}
              placeDetail={placeSubtitle(resolved.place)}
              source={resolved.source}
              config={config}
              general={settings.data?.general}
              tier={tier}
              wide={isWideCompact(size)}
            />
          )}
        </QueryView>
      );
  }
}

// ---------------------------------------------------------------------------

interface ViewProps {
  report: WeatherReport;
  meta: QueryViewMeta;
  placeName: string;
  placeDetail: string;
  source: LocationSource;
  config: WeatherConfig;
  general: GeneralSettings | undefined;
  tier: WeatherTier;
  /** Compact tier with room for a short hourly strip beside the current conditions. */
  wide?: boolean;
}

interface Display {
  locale: string | undefined;
  hourCycle: HourCycle;
  /** The report's zone and label offset (labels in the place's real local time). */
  zone: LabelZone;
  temp(value: number): string;
  tempValue(value: number): number;
}

function WeatherView({ report, meta, placeName, placeDetail, source, config, general, tier, wide = false }: ViewProps) {
  const now = useNow(60_000);
  const locale = resolveLocale(general?.locale ?? 'system');
  const hourCycle = hourCycleFor(general?.timeFormat ?? 'system');
  const tempUnit = displayTempUnit(config.units, general?.temperatureUnit, report.units.temperature);
  const windUnit = general?.windUnit ?? report.units.wind;
  const precipUnit = general?.precipUnit ?? report.units.precip;
  const display: Display = {
    locale,
    hourCycle,
    zone: { timezone: report.timezone, utcOffsetSeconds: report.utcOffsetSeconds },
    tempValue: (value) => convertTemp(value, report.units.temperature, tempUnit),
    temp: (value) => formatTemp(convertTemp(value, report.units.temperature, tempUnit), locale),
  };

  const nowLocal = placeNow(now, report);
  const hours = upcomingHours(report.hourly, nowLocal, HOURLY_STRIP_HOURS);
  const days = upcomingDays(report.daily, nowLocal);
  const today = days[0];
  const { current } = report;
  const condition = weatherCodeInfo(current.code, current.isDay).label;
  const isOld = meta.updatedAt > 0 && now.getTime() - meta.updatedAt > OLD_DATA_MS;

  const windSpeed = convertWind(current.windSpeed, report.units.wind, windUnit);
  const precipNow = convertPrecip(current.precip, report.units.precip, precipUnit);
  const PlaceIcon = source === 'device' ? LocateFixed : MapPin;
  const placeTitle = [placeName, placeDetail].filter(Boolean).join(', ');
  const hiLo = today ? `H ${display.temp(today.max)} L ${display.temp(today.min)}` : null;

  const showHourly = (tier !== 'compact' || wide) && config.show.hourly && hours.length > 0;
  const showDailyList = tier === 'large' && config.show.daily && days.length > 0;
  const showDayStrip = tier === 'medium' && !config.show.hourly && config.show.daily && days.length > 0;

  return (
    <div className={styles.root} data-tier={tier} data-wide={wide ? 'true' : undefined} data-testid="weather-view">
      <div className={styles.layout}>
        <WidgetActions>
          <StaleIndicator updatedAt={meta.updatedAt} error={meta.stale ? meta.error : undefined} always={isOld} onRetry={meta.refetch} />
        </WidgetActions>

        <section className={styles.current} aria-label={`Current weather in ${placeName}`}>
          <WeatherIcon code={current.code} isDay={current.isDay} className={styles.currentIcon} />
          <div className={styles.currentMain}>
            <p className={styles.temp}>
              <span className={styles.tempValue}>{display.temp(current.temp)}</span>
              <span className={styles.tempUnit}>{tempUnit}</span>
            </p>
            <p className={styles.condition}>{condition}</p>
            {tier === 'compact' ? (
              <p className={styles.compactPlace} title={placeTitle}>
                {placeName}
              </p>
            ) : null}
          </div>
          <div className={styles.currentAside}>
            <p className={styles.place} title={placeTitle}>
              {tier !== 'compact' ? <PlaceIcon aria-hidden="true" className={styles.placeIcon} /> : null}
              <span className={styles.placeName}>{placeName}</span>
            </p>
            {tier === 'large' && placeDetail ? <p className={styles.placeDetail}>{placeDetail}</p> : null}
            {tier !== 'compact' ? <p className={styles.feels}>Feels like {display.temp(current.apparent)}</p> : null}
            {hiLo ? (
              <p className={styles.hiLo}>
                <span className="hb-visually-hidden">Today: high {display.temp(today!.max)}, low {display.temp(today!.min)}</span>
                <span aria-hidden="true">{hiLo}</span>
              </p>
            ) : null}
          </div>
        </section>

        {tier !== 'compact' ? (
          <ul className={styles.details} aria-label="Conditions">
            <li className={styles.detail}>
              <Wind aria-hidden="true" className={styles.detailIcon} />
              <span className="hb-visually-hidden">Wind</span>
              <span>{formatWind(windSpeed, windUnit, locale)}</span>
              {windSpeed >= 0.5 ? (
                <span className={styles.windDir}>
                  <Navigation2
                    aria-hidden="true"
                    className={styles.windArrow}
                    style={{ transform: `rotate(${(current.windDir + 180) % 360}deg)` } as CSSProperties}
                  />
                  <abbr title={`From the ${compassWords(current.windDir)}`}>{compassPoint(current.windDir)}</abbr>
                </span>
              ) : null}
            </li>
            <li className={styles.detail}>
              <Droplets aria-hidden="true" className={styles.detailIcon} />
              <span className="hb-visually-hidden">Humidity</span>
              <span>{formatPercent(current.humidity, locale)}</span>
            </li>
            {precipNow > 0 ? (
              <li className={styles.detail} data-narrow-optional="true">
                <Umbrella aria-hidden="true" className={styles.detailIcon} />
                <span className="hb-visually-hidden">Precipitation now</span>
                <span>{formatPrecip(precipNow, precipUnit, locale)}</span>
              </li>
            ) : today && today.precipProb !== null ? (
              <li className={styles.detail} data-narrow-optional="true">
                <Umbrella aria-hidden="true" className={styles.detailIcon} />
                <span className="hb-visually-hidden">Chance of precipitation today</span>
                <span>{formatPercent(today.precipProb, locale)}</span>
              </li>
            ) : null}
            {tier === 'large' && today?.sunrise && today.sunset ? (
              // One item, so sunrise and sunset wrap together (never a lone sunset on its own line).
              <li className={styles.detail} data-optional="true">
                <Sunrise aria-hidden="true" className={styles.detailIcon} />
                <span className="hb-visually-hidden">Sunrise</span>
                <span>{clockLabel(today.sunrise, locale, hourCycle, display.zone)}</span>
                <Sunset aria-hidden="true" className={`${styles.detailIcon} ${styles.sunsetIcon}`} />
                <span className="hb-visually-hidden">Sunset</span>
                <span>{clockLabel(today.sunset, locale, hourCycle, display.zone)}</span>
              </li>
            ) : null}
          </ul>
        ) : null}

        {showHourly ? <HourlyStrip hours={hours} report={report} display={display} nowLocal={nowLocal} /> : null}
        {showDayStrip ? <DayStrip days={days} nowLocal={nowLocal} display={display} /> : null}
        {showDailyList ? <DailyList days={days} nowLocal={nowLocal} display={display} currentTemp={current.temp} /> : null}
      </div>
      <p className={styles.attribution}>
        <ExternalLink href={OPEN_METEO_URL} className={styles.attributionLink}>
          <span className={styles.attributionPrefix}>Weather data by</span> Open-Meteo.com
        </ExternalLink>
      </p>
    </div>
  );
}

function precipText(prob: number | null, locale: string | undefined): string | null {
  return prob !== null && prob >= PRECIP_LABEL_MIN ? formatPercent(prob, locale) : null;
}

function HourlyStrip({ hours, report, display, nowLocal }: { hours: WeatherHour[]; report: WeatherReport; display: Display; nowLocal: string }) {
  const currentHour = `${nowLocal.slice(0, 13)}:00`;
  // The precipitation row only takes space when some hour has a chance worth showing.
  const anyPrecip = hours.some((hour) => precipText(hour.precipProb, display.locale) !== null);
  return (
    <ScrollStrip label="Hourly forecast">
      <ol className={styles.hourList}>
        {hours.map((hour) => {
          // "Now" shows the current conditions so it matches the headline numbers.
          const isNow = hour.time === currentHour;
          const isDay = isNow ? report.current.isDay : isDaylight(hour.time, report.daily);
          const code = isNow ? report.current.code : hour.code;
          const temp = isNow ? report.current.temp : hour.temp;
          const label = isNow ? 'Now' : hourLabel(hour.time, display.locale, display.hourCycle, display.zone);
          const precip = precipText(hour.precipProb, display.locale);
          const condition = weatherCodeInfo(code, isDay).label;
          return (
            <li key={hour.time} className={styles.hour} data-now={isNow ? 'true' : undefined}>
              <span className="hb-visually-hidden">{`${label}: ${display.temp(temp)}, ${condition}${precip ? `, ${precip} chance of precipitation` : ''}`}</span>
              <span className={styles.hourTime} aria-hidden="true">
                {label}
              </span>
              <WeatherIcon code={code} isDay={isDay} className={styles.hourIcon} />
              <span className={styles.hourTemp} aria-hidden="true">
                {display.temp(temp)}
              </span>
              {anyPrecip ? (
                <span className={styles.hourPrecip} aria-hidden="true">
                  {precip ?? ''}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </ScrollStrip>
  );
}

function DayStrip({ days, nowLocal, display }: { days: WeatherDay[]; nowLocal: string; display: Display }) {
  return (
    <ScrollStrip label="Daily forecast">
      <ol className={styles.hourList}>
        {days.map((day) => (
          <li key={day.date} className={styles.hour}>
            <span className="hb-visually-hidden">{`${dayLongLabel(day.date, display.locale)}: ${weatherCodeInfo(day.code).label}, high ${display.temp(day.max)}, low ${display.temp(day.min)}`}</span>
            <span className={styles.hourTime} aria-hidden="true">
              {dayLabel(day.date, nowLocal, display.locale)}
            </span>
            <WeatherIcon code={day.code} className={styles.hourIcon} />
            <span className={styles.hourTemp} aria-hidden="true">
              {display.temp(day.max)}
            </span>
            <span className={styles.dayStripMin} aria-hidden="true">
              {display.temp(day.min)}
            </span>
          </li>
        ))}
      </ol>
    </ScrollStrip>
  );
}

function DailyList({ days, nowLocal, display, currentTemp }: { days: WeatherDay[]; nowLocal: string; display: Display; currentTemp: number }) {
  const lows = days.map((d) => display.tempValue(d.min));
  const highs = days.map((d) => display.tempValue(d.max));
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const span = Math.max(1, max - min);
  const pos = (value: number) => `${Math.min(100, Math.max(0, ((value - min) / span) * 100)).toFixed(1)}%`;
  const todayKey = nowLocal.slice(0, 10);

  return (
    <ol className={styles.daily} aria-label="7-day forecast">
      {days.map((day, i) => {
        const isToday = day.date === todayKey;
        const precip = precipText(day.precipProb, display.locale);
        const low = lows[i]!;
        const high = highs[i]!;
        const now = display.tempValue(currentTemp);
        const rangeStyle = { '--hb-range-from': pos(low), '--hb-range-to': pos(high) } as CSSProperties;
        return (
          <li key={day.date} className={styles.day} data-today={isToday ? 'true' : undefined}>
            <span className="hb-visually-hidden">{`${isToday ? dayLabel(day.date, nowLocal, display.locale) : dayLongLabel(day.date, display.locale)}: ${weatherCodeInfo(day.code).label}, low ${display.temp(day.min)}, high ${display.temp(day.max)}${precip ? `, ${precip} chance of precipitation` : ''}`}</span>
            <span className={styles.dayName} aria-hidden="true">
              {dayLabel(day.date, nowLocal, display.locale)}
            </span>
            <WeatherIcon code={day.code} className={styles.dayIcon} />
            <span className={styles.dayPrecip} aria-hidden="true">
              {precip ?? ''}
            </span>
            <span className={styles.dayMin} aria-hidden="true">
              {display.temp(day.min)}
            </span>
            <span className={styles.dayBar} aria-hidden="true">
              <span className={styles.dayRange} style={rangeStyle} />
              {isToday && now >= low && now <= high ? (
                <span className={styles.dayNow} style={{ '--hb-range-at': pos(now) } as CSSProperties} />
              ) : null}
            </span>
            <span className={styles.dayMax} aria-hidden="true">
              {display.temp(day.max)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function WeatherSkeleton({ tier }: { tier: WeatherTier }) {
  return (
    <div className={styles.root} data-tier={tier} role="status" aria-label="Loading weather">
      <div className={styles.layout}>
        <div className={styles.current}>
          <Skeleton width={44} height={44} round />
          <div className={styles.skeletonStack}>
            <Skeleton width={72} height={26} />
            <Skeleton width={96} height={10} />
          </div>
        </div>
        {tier !== 'compact' ? (
          <div className={styles.skeletonStrip}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} width={36} height={56} />
            ))}
          </div>
        ) : null}
        {tier === 'large' ? (
          <div className={styles.skeletonStack}>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} height={12} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
