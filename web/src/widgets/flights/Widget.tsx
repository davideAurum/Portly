/**
 * Flight tracker widget (§10.8 Flights): the flights typed into its settings plus, when on, flight
 * numbers found in calendar events over the next 30 days. One row per flight, soonest first:
 * flight number, route, a status badge (on time, delayed, in the air, landed, cancelled), the
 * departure and arrival times in each airport's own zone with gate and terminal, and a progress
 * bar while under way. A row opens the flight on flightaware.com; its × removes it (a calendar
 * flight stays dismissed). Flights over for 6 hours drop off. Everything FlightAware supplies is
 * plain text rendered as React text.
 */
import { useMemo } from 'react';
import { CalendarDays, KeyRound, Plane, X } from 'lucide-react';
import type { FlightEnd, FlightInfo, FlightStatus } from '@portly/shared';
import { isApiError, ApiError } from '../../api/client.ts';
import { useCalendarEvents } from '../../api/calendar.ts';
import { useFlightStatuses, useFlightsKey } from '../../api/flights.ts';
import { useWidgetFrame, WidgetActions } from '../../grid/WidgetContext.tsx';
import { useFormatters, type Formatters } from '../../lib/format.ts';
import { linkProps, safeHref } from '../../lib/openUrl.ts';
import { useNow } from '../../lib/useNow.ts';
import { Badge } from '../../ui/Badge.tsx';
import { Button, IconButton } from '../../ui/Button.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState, StaleIndicator } from '../../ui/ErrorState.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { errorMessage } from '../../ui/toast.ts';
import type { WidgetProps } from '../types.ts';
import type { FlightsConfig } from './index.ts';
import { addDays, flightKey, flightsFromEvents, isDone, localDateOf, lookupNote, mergeFlights, sortTime, statusBadge, type TrackedFlight } from './model.ts';
import styles from './Flights.module.css';

export const SETTINGS_ROUTE = '#/settings/accounts?focus=flightaware';
const CALENDAR_DAYS = 30;

const NOT_CONNECTED = new ApiError(409, 'not_configured', 'Add your FlightAware AeroAPI key to track flights.');

export default function FlightsWidget({ config, setConfig, size }: WidgetProps<FlightsConfig>) {
  const frame = useWidgetFrame();
  const fmt = useFormatters();
  const now = useNow(60_000).getTime();
  const compact = size.h <= 3 || size.w <= 3;
  const key = useFlightsKey();
  const configured = key.data?.configured === true;

  const today = localDateOf(now);
  const range = useMemo(() => ({ from: addDays(today, -1), to: addDays(today, CALENDAR_DAYS), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }), [today]);
  const events = useCalendarEvents(range, { enabled: config.fromCalendar });
  const tracked = useMemo(
    () => mergeFlights(config.flights, config.fromCalendar ? flightsFromEvents(events.data?.events ?? []) : [], config.dismissed),
    [config.flights, config.fromCalendar, config.dismissed, events.data],
  );
  const queries = useFlightStatuses(tracked, configured);

  const rows = tracked
    .map((flight, i) => ({ flight, query: queries[i]! }))
    .filter((row) => !isDone(row.flight, row.query.data, now))
    .sort((a, b) => sortTime(a.flight, a.query.data) - sortTime(b.flight, b.query.data));

  const remove = (flight: TrackedFlight) => {
    if (flight.source === 'manual') void setConfig({ flights: config.flights.filter((f) => flightKey(f) !== flightKey(flight)) });
    else void setConfig({ dismissed: [...config.dismissed, flightKey(flight)].slice(-100) });
  };

  if (key.data?.configured === false) return <SetupError error={NOT_CONNECTED} onRetry={() => void key.refetch()} compact={compact} />;
  if (key.data === undefined) {
    return key.isError ? <ErrorState error={key.error} onRetry={() => void key.refetch()} compact={compact} /> : <SkeletonList rows={2} />;
  }

  // Setup problems can't fix themselves: show them instead of the list.
  const blocking = queries.find((q) => q.isError && (isApiError(q.error, 'not_configured') || isApiError(q.error, 'reauth_required')));
  if (blocking) return <SetupError error={blocking.error} onRetry={() => void blocking.refetch()} compact={compact} />;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Plane}
        compact={compact}
        title="No flights to track"
        body={config.fromCalendar ? 'Add a flight number, or put one in a calendar event title (“Flight to Denver UA 123”).' : 'Add a flight number and its date.'}
        action={
          frame.canOpenSettings ? (
            <Button size="sm" variant="primary" onClick={() => frame.openSettings({ focus: 'flights-add' })}>
              Add a flight
            </Button>
          ) : undefined
        }
      />
    );
  }

  const loaded = rows.filter((r) => r.query.data !== undefined);
  const updatedAt = loaded.length > 0 ? Math.min(...loaded.map((r) => r.query.dataUpdatedAt)) : 0;
  const refreshError = loaded.find((r) => r.query.isError)?.query.error;
  const retryAll = () => {
    for (const r of rows) if (r.query.isError) void r.query.refetch();
  };

  return (
    <div className={styles.root}>
      {updatedAt > 0 ? (
        <WidgetActions>
          <StaleIndicator updatedAt={updatedAt} error={refreshError} onRetry={retryAll} />
        </WidgetActions>
      ) : null}
      <ul className={styles.list} aria-label="Flights">
        {rows.map(({ flight, query }) => (
          <li key={flightKey(flight)} className={styles.row}>
            {query.data !== undefined ? (
              <FlightRow flight={flight} status={query.data} fmt={fmt} now={now} compact={compact} />
            ) : query.isError ? (
              <div className={styles.flight}>
                <Header flight={flight} title={flight.ident} />
                <p className={styles.note}>
                  {errorMessage(query.error)}{' '}
                  <button type="button" className={styles.inlineButton} onClick={() => void query.refetch()}>
                    Retry
                  </button>
                </p>
              </div>
            ) : (
              <div className={styles.flight}>
                <Header flight={flight} title={flight.ident} />
                <SkeletonList rows={1} />
              </div>
            )}
            <IconButton
              size="sm"
              icon={X}
              className={styles.remove}
              aria-label={`Stop tracking ${flight.ident} on ${flight.date}`}
              title={flight.source === 'calendar' ? 'Hide this calendar flight' : 'Stop tracking'}
              onClick={() => remove(flight)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SetupError({ error, onRetry, compact }: { error: unknown; onRetry(): void; compact: boolean }) {
  if (isApiError(error, 'reauth_required') && !error.accountId) {
    const href = safeHref('#/settings/accounts');
    return (
      <EmptyState
        icon={KeyRound}
        compact={compact}
        title="Saved credentials are locked"
        body="Portly can't unlock its stored credentials. Reset them in Settings → Accounts, then add your FlightAware key again."
        action={
          href ? (
            <a className={styles.cta} href={href}>
              <KeyRound aria-hidden="true" />
              Open settings
            </a>
          ) : undefined
        }
      />
    );
  }
  const reason = isApiError(error, 'not_configured') ? (error.details as { reason?: unknown } | undefined)?.reason : undefined;
  return (
    <ErrorState
      error={error}
      onRetry={onRetry}
      setupHref={SETTINGS_ROUTE}
      setupLabel="Set up FlightAware"
      title={reason === 'token_rejected' ? 'FlightAware key refused' : isApiError(error, 'not_configured') ? 'Connect FlightAware' : undefined}
      compact={compact}
    />
  );
}

function Header({ flight, title, route }: { flight: TrackedFlight; title: string; route?: string }) {
  return (
    <div className={styles.header}>
      <span className={styles.ident}>{title}</span>
      {route ? <span className={styles.route}>{route}</span> : null}
      {flight.source === 'calendar' ? <CalendarDays className={styles.source} aria-label="From your calendar" /> : null}
    </div>
  );
}

function FlightRow({ flight, status, fmt, now, compact }: { flight: TrackedFlight; status: FlightStatus; fmt: Formatters; now: number; compact: boolean }) {
  const info = status.flight;
  if (info === null) {
    return (
      <div className={styles.flight}>
        <Header flight={flight} title={flight.ident} />
        <p className={styles.note}>
          {fmt.date(`${flight.date}T12:00:00Z`, 'weekday-short', 'UTC')} · {lookupNote(status)}
        </p>
      </div>
    );
  }
  const badge = statusBadge(info, now);
  const route = info.origin && info.destination ? `${info.origin.code} → ${info.destination.code}` : undefined;
  const link = info.url ? linkProps(info.url) : null;
  const body = (
    <>
      <div className={styles.top}>
        <Header flight={flight} title={info.ident} route={route} />
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {compact ? null : (
        <div className={styles.ends}>
          <End label="Departs" end={info.departure} zone={info.origin?.timezone ?? null} place={info.origin?.city ?? info.origin?.code ?? null} fmt={fmt} />
          <End label="Arrives" end={info.arrival} zone={info.destination?.timezone ?? null} place={info.destination?.city ?? info.destination?.code ?? null} fmt={fmt} />
        </div>
      )}
      {info.progressPercent !== null && (info.phase === 'airborne' || info.phase === 'taxiing' || info.phase === 'landed') ? (
        <div className={styles.progress} role="progressbar" aria-label="Flight progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={info.progressPercent}>
          <span className={styles.progressFill} style={{ inlineSize: `${info.progressPercent}%` }} />
          <Plane className={styles.progressPlane} style={{ insetInlineStart: `${info.progressPercent}%` }} aria-hidden="true" />
        </div>
      ) : null}
      {!compact && info.baggageClaim && (info.phase === 'landed' || info.phase === 'arrived') ? <p className={styles.note}>Baggage claim {info.baggageClaim}</p> : null}
    </>
  );
  return link ? (
    <a className={styles.flight} {...link} title={`${info.ident} on FlightAware`}>
      {body}
    </a>
  ) : (
    <div className={styles.flight}>{body}</div>
  );
}

function End({ label, end, zone, place, fmt }: { label: string; end: FlightEnd; zone: string | null; place: string | null; fmt: Formatters }) {
  const shown = end.actual ?? end.estimated ?? end.scheduled;
  const changed = end.scheduled !== null && shown !== null && Math.abs(Date.parse(shown) - Date.parse(end.scheduled)) >= 5 * 60_000;
  const timeZone = zone ?? undefined;
  const where = [end.terminal ? `Terminal ${end.terminal}` : null, end.gate ? `Gate ${end.gate}` : null].filter(Boolean).join(' · ');
  return (
    <div className={styles.end}>
      <span className={styles.endLabel}>
        {label}
        {place ? ` · ${place}` : ''}
      </span>
      <span className={styles.endTime}>
        {shown ? fmt.time(shown, { timeZone }) : '—'}
        {changed && end.scheduled ? <s className={styles.was}>{fmt.time(end.scheduled, { timeZone })}</s> : null}
        {shown ? <span className={styles.day}>{fmt.date(shown, 'weekday-short', timeZone)}</span> : null}
      </span>
      {where ? <span className={styles.where}>{where}</span> : null}
    </div>
  );
}

export type { FlightInfo };
