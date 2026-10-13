/**
 * Clock widget (§10.8 Clock): time (12/24-hour from the widget or settings.general.timeFormat,
 * locale-aware), optional seconds (one shared 1 s ticker, otherwise a minute ticker aligned to
 * :00), date, a greeting by time of day with settings.general.userName, and extra time zones.
 * The time scales with the card (container query units); zones appear from the medium size on.
 */
import { useMemo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useSettings } from '../../api/settings.ts';
import { resolveLocale } from '../../lib/format.ts';
import { useNow } from '../../lib/useNow.ts';
import type { WidgetProps } from '../types.ts';
import type { ClockConfig } from './index.ts';
import {
  clockTier,
  describeOffsetDiff,
  effectiveTimeFormat,
  formatOffsetDiff,
  greetingText,
  localTimeZone,
  longDate,
  relativeDay,
  timeParts,
  zoneDayDiff,
  zoneOffsetMinutes,
  type TimeFormat,
} from './clock.ts';
import styles from './Widget.module.css';

export default function ClockWidget({ config, size }: WidgetProps<ClockConfig>) {
  const settings = useSettings();
  const general = settings.data?.general;
  const settingsKnown = settings.data !== undefined || settings.isError;
  const now = useNow(config.showSeconds ? 1000 : 60_000);
  const locale = resolveLocale(general?.locale ?? 'system');
  const timeFormat = effectiveTimeFormat(config.format, general?.timeFormat);
  const tier = clockTier(size);
  const parts = timeParts(now, { locale, timeFormat, seconds: config.showSeconds });
  // Wait for settings before greeting, so the name does not pop in a moment later.
  const greeting = config.greeting && tier !== 'compact' && settingsKnown ? greetingText(now, general?.userName) : null;
  const zones = tier === 'compact' ? [] : config.extraZones;

  return (
    <div
      className={styles.root}
      data-tier={tier}
      data-seconds={config.showSeconds ? 'true' : undefined}
      data-period={parts.dayPeriod ? 'true' : undefined}
    >
      <div className={styles.layout}>
        <div className={styles.main}>
          {greeting ? <p className={styles.greeting}>{greeting}</p> : null}
          <time className={styles.time} dateTime={now.toISOString()}>
            <span className="hb-visually-hidden">{parts.text}</span>
            <span className={styles.timeVisual} aria-hidden="true" data-testid="clock-time">
              {parts.dayPeriod && parts.dayPeriodFirst ? <span className={styles.period}>{parts.dayPeriod}</span> : null}
              <span className={styles.digits}>{parts.main}</span>
              {parts.dayPeriod && !parts.dayPeriodFirst ? <span className={styles.period}>{parts.dayPeriod}</span> : null}
            </span>
          </time>
          {config.showDate ? <p className={styles.date}>{longDate(now, locale)}</p> : null}
        </div>
        {zones.length > 0 ? (
          <ExtraZones zones={zones} now={now} locale={locale} timeFormat={timeFormat} layout={tier === 'large' ? 'list' : 'chips'} />
        ) : null}
      </div>
    </div>
  );
}

interface ExtraZonesProps {
  zones: ClockConfig['extraZones'];
  now: Date;
  locale: string | undefined;
  timeFormat: TimeFormat;
  layout: 'list' | 'chips';
}

/**
 * Chips that do not fit on the one chip row are summed up as a "+N" chip listing them (UX-7).
 * Measured before paint: render everything, then hide trailing chips while any item wraps.
 */
function useHiddenChips(list: RefObject<HTMLUListElement | null>, enabled: boolean, count: number, rendered: number): number {
  const [hidden, setHidden] = useState(0);
  const [width, setWidth] = useState(0);
  const measuredFor = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = list.current;
    if (!enabled || !el) return;
    // A new width (or zone list) starts over from "everything shown".
    const key = `${width}|${count}|${rendered}`;
    if (measuredFor.current !== key) {
      measuredFor.current = key;
      if (hidden !== 0) {
        setHidden(0);
        return;
      }
    }
    const items = [...el.children] as HTMLElement[];
    const top = items[0]?.offsetTop ?? 0;
    const wraps = items.some((item) => item.offsetTop > top);
    if (wraps && hidden < count - 1) setHidden(hidden + 1);
  }, [list, enabled, count, hidden, rendered, width]);

  useEffect(() => {
    const el = list.current;
    if (!enabled || !el || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [list, enabled]);

  return enabled ? hidden : 0;
}

function ExtraZones({ zones, now, locale, timeFormat, layout }: ExtraZonesProps) {
  const home = useMemo(() => localTimeZone(), []);
  const homeOffset = zoneOffsetMinutes(home, now);
  const listRef = useRef<HTMLUListElement>(null);
  const chips = layout === 'chips';
  const hiddenCount = useHiddenChips(listRef, chips, zones.length, zones.length);
  const shown = hiddenCount > 0 ? zones.slice(0, zones.length - hiddenCount) : zones;
  const hiddenZones = zones.slice(shown.length);
  return (
    <ul ref={listRef} className={styles.zones} data-layout={layout} aria-label="Other time zones">
      {shown.map((zone, index) => {
        const time = timeParts(now, { locale, timeFormat, timeZone: zone.tz });
        const diff = zoneOffsetMinutes(zone.tz, now) - homeOffset;
        const dayDiff = zoneDayDiff(zone.tz, home, now);
        const day = relativeDay(dayDiff, locale);
        const meta = `${day} · ${formatOffsetDiff(diff)}`;
        return (
          <li key={`${zone.tz}-${index}`} className={styles.zone} title={`${zone.tz} · ${meta}`}>
            <span className="hb-visually-hidden">{`${zone.label}: ${time.text}, ${day.toLocaleLowerCase(locale)}, ${describeOffsetDiff(diff)}`}</span>
            <span className={styles.zoneText} aria-hidden="true">
              <span className={styles.zoneLabel}>{zone.label}</span>
              {layout === 'list' ? <span className={styles.zoneMeta}>{meta}</span> : null}
            </span>
            <span className={styles.zoneTime} aria-hidden="true">
              {time.main}
              {time.dayPeriod ? <span className={styles.zonePeriod}> {time.dayPeriod}</span> : null}
              {layout === 'chips' && dayDiff !== 0 ? (
                <sup className={styles.zoneDay}>{dayDiff > 0 ? `+${dayDiff}` : `−${Math.abs(dayDiff)}`}</sup>
              ) : null}
            </span>
          </li>
        );
      })}
      {hiddenZones.length > 0 ? (
        <li className={`${styles.zone} ${styles.moreZones}`} title={hiddenZones.map((z) => z.label).join(', ')}>
          <span className="hb-visually-hidden">{`${hiddenZones.length} more: ${hiddenZones.map((z) => z.label).join(', ')}`}</span>
          <span aria-hidden="true">+{hiddenZones.length}</span>
        </li>
      ) : null}
    </ul>
  );
}
