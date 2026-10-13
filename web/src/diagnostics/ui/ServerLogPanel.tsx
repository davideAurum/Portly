/**
 * Diagnostics → Server log (ARCHITECTURE §17): the server's recent log records (its memory rings)
 * with filters — level (Errors / Warnings / Info / All), area, source (server or browsers), text —
 * and chips: a record's request, job, run, account and calendar (accounts and calendars by name)
 * filter to that value when clicked. Rows expand to their fields as formatted JSON.
 *
 * - **Live** polls `after=<last seq>` every 2 s and appends what is new to this component's state
 *   (one query per filter set, never one per `after`); polling skips a tick while one is pending
 *   or the tab is hidden, and stops when the panel closes. While it runs the first page does not
 *   refetch when the tab is shown again (that would move the cursor past what arrived meanwhile);
 *   a poll that answers more than 500 new records says that Live skipped some.
 * - **A restart** (a poll answers a `lastSeq` below the one asked after — the server numbers its
 *   records per process — or the summary's boot id changes) starts the list over from the new
 *   process's first page; its older records are in the log files.
 * - **Show older** reads the log files backwards, the first batch from the newest record shown
 *   from memory (the rings reach back unequally far: a busy area's debug lines are gone long
 *   before the info lines around them), leaving out what memory shows, until the list holds
 *   2 000 rows.
 * - **Timeline** merges this browser's own events (This browser) into the list by time.
 *
 * The list keeps the newest 2 000 rows and scrolls in its own box, so new rows never move the page.
 * Every row is a stop for the Tab key (its head and chips): "Skip to the end of the log", shown
 * when it has keyboard focus, takes a keyboard user past them to Show older.
 */
import { memo, useCallback, useEffect, useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import { DIAGNOSTIC_AREAS, type LogRecord } from '@portly/shared';
import { getDiagnosticsLogs, useDiagnosticsLogs } from '../../api/diagnostics.ts';
import { useFormatters } from '../../lib/format.ts';
import { Badge } from '../../ui/Badge.tsx';
import { Button } from '../../ui/Button.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input, Select } from '../../ui/Input.tsx';
import { SettingsCard } from '../../ui/Section.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { errorMessage, toastError } from '../../ui/toast.ts';
import { SegmentedControl, Switch } from '../../ui/Toggles.tsx';
import { areaLabel, diagnosticsUnavailable, logTime } from './format.ts';
import { useClientEvents, useDebouncedValue } from './hooks.ts';
import {
  DEFAULT_LOG_FILTERS,
  LIVE_POLL_MS,
  LOG_PAGE_SIZE,
  MAX_LOG_ROWS,
  MAX_OLDER_REQUESTS,
  addOlderBatch,
  hasNarrowingFilters,
  isLate,
  logRows,
  logsQueryFor,
  mergeLogRecords,
  newFileRecords,
  nextOlderBefore,
  olderBefore,
  recordChips,
  type LogChipField,
  type LogFilters,
  type LogNames,
  type LogRow,
} from './logs.ts';
import { FieldsView, LevelBadge, UnavailableNotice } from './parts.tsx';
import styles from './Diagnostics.module.css';

export type { LogNames } from './logs.ts';

const LEVEL_OPTIONS = [
  { value: 'error', label: 'Errors' },
  { value: 'warn', label: 'Warnings' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'All' },
] as const;

const AREA_OPTIONS = [{ value: '', label: 'All areas' }, ...DIAGNOSTIC_AREAS.map((area) => ({ value: area, label: areaLabel(area) }))];

const SOURCE_OPTIONS = [
  { value: '', label: 'All sources' },
  { value: 'server', label: 'Server' },
  { value: 'client', label: 'Browsers' },
];

const CHIP_LABELS: Readonly<Record<LogChipField, string>> = {
  rid: 'Request',
  job: 'Job',
  run: 'Run',
  accountId: 'Account',
  calendarId: 'Calendar',
};

function chipText(field: LogChipField, value: string, names: LogNames): string {
  if (field === 'accountId') return names.account(value) ?? value;
  if (field === 'calendarId') return names.calendar(value) ?? value;
  return value;
}

interface RowViewProps {
  row: LogRow;
  names: LogNames;
  chips: LogFilters['chips'];
  onChip(field: LogChipField, value: string): void;
}

const LogRowView = memo(function LogRowView({ row, names, chips, onChip }: RowViewProps) {
  const [open, setOpen] = useState(false);
  const fmt = useFormatters();
  const fieldsId = useId();
  const server = row.kind === 'server';
  const level = server ? row.record.level : row.entry.event.level;
  const time = server ? (row.record.tEvent ?? row.record.t) : row.entry.event.t;
  const msg = server ? row.record.msg : row.entry.event.msg;
  const origin = server
    ? `${row.record.src === 'client' ? 'browser · ' : row.record.src === 'supervisor' ? 'supervisor · ' : ''}${row.record.area}`
    : `this browser · ${row.entry.event.cat}`;
  const rowChips: [LogChipField, string][] = server
    ? recordChips(row.record)
    : (['rid', 'accountId'] as const).flatMap((field) => {
        const value = row.entry.event.fields[field];
        return typeof value === 'string' && value !== '' ? [[field, value] as [LogChipField, string]] : [];
      });
  const fields = server ? (row.record.rid === null ? row.record.fields : { rid: row.record.rid, ...row.record.fields }) : row.entry.event.fields;
  return (
    <li className={styles.logRow} data-level={level} data-kind={row.kind}>
      <button type="button" className={styles.logHead} aria-expanded={open} aria-controls={open ? fieldsId : undefined} onClick={() => setOpen((v) => !v)} title={fmt.dateTime(time)}>
        <ChevronRight aria-hidden="true" className={styles.chevron} />
        <span className={styles.time}>{logTime(time)}</span>
        <LevelBadge level={level} />
        <span className={styles.area}>{origin}</span>
        <span className={styles.msg}>{msg}</span>
        {server && isLate(row.record) ? (
          <Badge tone="warning" title="This browser event reached Portly more than 5 minutes after it happened">
            late
          </Badge>
        ) : null}
      </button>
      {rowChips.length > 0 ? (
        <div className={`${styles.chips} ${styles.rowChips}`}>
          {rowChips.map(([field, value]) => (
            <button
              key={field}
              type="button"
              className={styles.chip}
              data-active={chips[field] === value ? 'true' : undefined}
              aria-pressed={chips[field] === value}
              onClick={() => onChip(field, value)}
              title={`Show only records of this ${CHIP_LABELS[field].toLowerCase()}`}
            >
              {CHIP_LABELS[field]} {chipText(field, value, names)}
            </button>
          ))}
        </div>
      ) : null}
      {open ? <FieldsView fields={fields} id={fieldsId} /> : null}
    </li>
  );
}, sameRowProps);

/** Rows are rebuilt on every render (each Live poll): a row re-renders only when its record or event, names or chips change. */
function sameRowProps(a: RowViewProps, b: RowViewProps): boolean {
  const sameItem = a.row.kind === 'server' ? b.row.kind === 'server' && a.row.record === b.row.record : b.row.kind === 'browser' && a.row.entry === b.row.entry;
  return sameItem && a.row.id === b.row.id && a.names === b.names && a.chips === b.chips && a.onChip === b.onChip;
}

export interface ServerLogPanelProps {
  filters: LogFilters;
  setFilters: Dispatch<SetStateAction<LogFilters>>;
  timeline: boolean;
  setTimeline(on: boolean): void;
  names: LogNames;
  /** The server's boot id (the summary's): another one means it restarted. */
  boot?: string | null;
}

interface Appended {
  key: string;
  records: LogRecord[];
  lastSeq: number;
  /** A poll answered more than a page: the records between were skipped. */
  gap: boolean;
}

interface Older {
  key: string;
  records: LogRecord[];
  done: boolean;
  /** Where the next batch starts ({@link nextOlderBefore}). */
  next: string;
}

export function ServerLogPanel({ filters, setFilters, timeline, setTimeline, names, boot = null }: ServerLogPanelProps) {
  const fmt = useFormatters();
  // The search box asks the server once typing pauses; a change from outside (Clear filters,
  // "Show related log lines") replaces what is typed.
  const [search, setSearch] = useState(filters.q);
  const [seenQ, setSeenQ] = useState(filters.q);
  if (filters.q !== seenQ) {
    setSeenQ(filters.q);
    setSearch(filters.q);
  }
  const debouncedSearch = useDebouncedValue(search, 350);
  useEffect(() => {
    setFilters((current) => (current.q === debouncedSearch ? current : { ...current, q: debouncedSearch }));
  }, [debouncedSearch, setFilters]);

  const [live, setLive] = useState(false);
  const query = logsQueryFor(filters);
  const queryKey = JSON.stringify(query);
  // While Live runs, a refetch would move the cursor past what arrived while the tab was hidden.
  const page = useDiagnosticsLogs(query, live ? { refetchOnWindowFocus: false } : {});
  const pageLastSeq = page.data?.lastSeq ?? 0;

  const [liveError, setLiveError] = useState<unknown>(null);
  const [appended, setAppended] = useState<Appended | null>(null);
  const [older, setOlder] = useState<Older | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const footerRef = useRef<HTMLDivElement>(null);
  const appendedRecords = appended?.key === queryKey ? appended.records : [];
  const olderState = older?.key === queryKey ? older : null;

  // Where the next Live poll starts: the newest record seen for these filters.
  const cursor = Math.max(pageLastSeq, appended?.key === queryKey ? appended.lastSeq : 0);
  const cursorRef = useRef(cursor);

  // The server restarted: the new process numbers its records from 1 again, so what Live appended
  // (and its seqs) belongs to the old one. Start over from the new first page; Live waits for it.
  const restartingRef = useRef(false);
  const { refetch } = page;
  const startOver = () => {
    setAppended(null);
    setOlder(null);
    restartingRef.current = true;
    void refetch()
      .then((result) => {
        if (result.data !== undefined) cursorRef.current = result.data.lastSeq;
      })
      .finally(() => {
        restartingRef.current = false;
      });
  };
  const startOverRef = useRef(startOver);
  useEffect(() => {
    cursorRef.current = cursor;
    startOverRef.current = startOver;
  });
  const bootRef = useRef(boot);
  useEffect(() => {
    if (boot === null) return;
    const before = bootRef.current;
    bootRef.current = boot;
    if (before !== null && before !== boot) startOverRef.current();
  }, [boot]);

  const pageLoaded = page.data !== undefined;
  useEffect(() => {
    if (!live || !pageLoaded) return;
    const controller = new AbortController();
    const pollQuery = JSON.parse(queryKey) as typeof query;
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy || restartingRef.current || document.visibilityState === 'hidden') return;
      busy = true;
      const after = cursorRef.current;
      getDiagnosticsLogs({ ...pollQuery, after }, controller.signal)
        .then((res) => {
          if (controller.signal.aborted) return;
          setLiveError(null);
          if (res.lastSeq < after) {
            startOverRef.current();
            return;
          }
          const newest = res.records.reduce((max, r) => Math.max(max, r.seq), Math.max(after, res.lastSeq));
          if (res.records.length === 0 && newest === after) return;
          setAppended((prev) => {
            const base = prev?.key === queryKey ? prev : { key: queryKey, records: [], lastSeq: 0, gap: false };
            const known = new Set(base.records.map((r) => r.seq));
            const records = [...base.records, ...res.records.filter((r) => !known.has(r.seq))];
            return {
              key: queryKey,
              records: records.length > MAX_LOG_ROWS ? records.slice(records.length - MAX_LOG_ROWS) : records,
              lastSeq: Math.max(base.lastSeq, newest),
              gap: base.gap || res.truncated,
            };
          });
          cursorRef.current = Math.max(cursorRef.current, newest);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setLiveError(error);
          if (diagnosticsUnavailable(error)) setLive(false);
        })
        .finally(() => {
          busy = false;
        });
    }, LIVE_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [live, pageLoaded, queryKey]);

  const records = mergeLogRecords(olderState?.records ?? [], page.data?.records ?? [], appendedRecords);
  const browserEvents = useClientEvents();
  const rows = logRows(records, timeline ? browserEvents : null, filters);
  const full = records.length >= MAX_LOG_ROWS || rows.length >= MAX_LOG_ROWS;

  const showOlder = async () => {
    setOlderLoading(true);
    try {
      const memory = [...(page.data?.records ?? []), ...appendedRecords];
      const shownOlder = olderState?.records ?? [];
      let before = olderState?.next ?? olderBefore(memory, filters, Date.now());
      let batch: LogRecord[] = [];
      let done = false;
      // The first batches may repeat only what the list shows: read on until something is new.
      for (let i = 0; i < MAX_OLDER_REQUESTS; i++) {
        const res = await getDiagnosticsLogs({ ...query, scope: 'files', before, limit: LOG_PAGE_SIZE });
        done = res.records.length === 0 || (!res.truncated && res.records.length < LOG_PAGE_SIZE);
        batch = newFileRecords(res.records, memory, shownOlder);
        before = nextOlderBefore(res.records, before) ?? before;
        if (batch.length > 0 || done) break;
      }
      const next = before;
      setOlder((prev) => {
        const base = prev?.key === queryKey ? prev.records : [];
        return { key: queryKey, records: addOlderBatch(batch, base), done, next };
      });
    } catch (error) {
      toastError(error, 'Older log records could not be read.');
    } finally {
      setOlderLoading(false);
    }
  };

  const onChip = useCallback(
    (field: LogChipField, value: string) =>
      setFilters((current) => {
        const chips = { ...current.chips };
        if (chips[field] === value) delete chips[field];
        else chips[field] = value;
        return { ...current, chips };
      }),
    [setFilters],
  );

  const activeChips: { id: string; label: string; remove(): void }[] = [];
  if (filters.key !== null) {
    activeChips.push({ id: 'key', label: `Subject: ${filters.keyLabel ?? filters.key}`, remove: () => setFilters((c) => ({ ...c, key: null, keyLabel: null })) });
  }
  if (filters.since !== null || filters.before !== null) {
    const from = filters.since === null ? '…' : fmt.dateTime(filters.since);
    const to = filters.before === null ? 'now' : fmt.dateTime(filters.before);
    activeChips.push({ id: 'window', label: `${from} – ${to}`, remove: () => setFilters((c) => ({ ...c, since: null, before: null })) });
  }
  for (const [field, value] of Object.entries(filters.chips) as [LogChipField, string][]) {
    activeChips.push({
      id: field,
      label: `${CHIP_LABELS[field]}: ${chipText(field, value, names)}`,
      remove: () => setFilters((c) => {
        const chips = { ...c.chips };
        delete chips[field];
        return { ...c, chips };
      }),
    });
  }

  let body: ReactNode;
  if (page.data === undefined) {
    if (page.isError) {
      body = diagnosticsUnavailable(page.error) ? <UnavailableNotice /> : <ErrorState error={page.error} onRetry={() => void page.refetch()} compact />;
    } else {
      body = <SkeletonList rows={6} avatar={false} />;
    }
  } else {
    body = (
      <>
        {rows.length > 0 ? (
          <button
            type="button"
            className={styles.skipLink}
            onClick={() => {
              const footer = footerRef.current;
              (footer?.querySelector<HTMLElement>('button:not(:disabled)') ?? footer)?.focus();
            }}
          >
            Skip to the end of the log
          </button>
        ) : null}
        <div className={styles.logBox}>
          {rows.length === 0 ? (
            <p className={styles.empty}>{hasNarrowingFilters(filters) || filters.level !== 'debug' ? 'No records match these filters.' : 'No records yet.'}</p>
          ) : (
            <ul className={styles.list} aria-label="Log records">
              {rows.map((row) => (
                <LogRowView key={row.id} row={row} names={names} chips={filters.chips} onChip={onChip} />
              ))}
            </ul>
          )}
        </div>
        <div className={styles.footer} ref={footerRef} tabIndex={-1}>
          {olderState?.done ? (
            <span className={styles.text}>No older records in the log files.</span>
          ) : full ? (
            // Older records would fall off the end of the list at once.
            <span className={styles.text}>The list keeps {MAX_LOG_ROWS} rows: narrow the filters or the time window to look further back.</span>
          ) : (
            <Button size="sm" loading={olderLoading} onClick={() => void showOlder()}>
              Show older (log files)
            </Button>
          )}
        </div>
      </>
    );
  }

  const count = `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;
  const notes = [
    live ? (liveError === null ? 'live' : `live update failed: ${errorMessage(liveError)}`) : null,
    page.data?.truncated && olderState === null ? `the newest ${LOG_PAGE_SIZE} records of the server's memory` : null,
    appended?.key === queryKey && appended.gap ? `some records skipped (more than ${LOG_PAGE_SIZE} arrived at once)` : null,
    full ? `the newest ${MAX_LOG_ROWS} are kept` : null,
  ].filter((note): note is string => note !== null);

  return (
    <SettingsCard
      id="diagnostics-log"
      title="Server log"
      description="Recent records from Portly's memory; older ones come from its log files. Live follows new records, Timeline adds this browser's own events. Nothing here contains passwords, tokens or the contents of your mail, calendars or tasks."
      actions={
        <div className={styles.inlineRow}>
          <Switch size="sm" label="Timeline" checked={timeline} onCheckedChange={setTimeline} />
          <Switch size="sm" label="Live" checked={live} onCheckedChange={setLive} disabled={!pageLoaded} />
        </div>
      }
    >
      <div className={styles.filters}>
        <Field label="Level" className={styles.filter}>
          <SegmentedControl size="sm" value={filters.level} options={LEVEL_OPTIONS} onValueChange={(level) => setFilters((c) => ({ ...c, level }))} />
        </Field>
        <Field label="Area" className={styles.filter}>
          <Select size="sm" value={filters.area} options={AREA_OPTIONS} onChange={(event) => setFilters((c) => ({ ...c, area: event.currentTarget.value }))} />
        </Field>
        <Field label="Source" className={styles.filter}>
          <Select
            size="sm"
            value={filters.src}
            options={SOURCE_OPTIONS}
            onChange={(event) => {
              const src = event.currentTarget.value;
              setFilters((c) => ({ ...c, src: src === 'server' || src === 'client' ? src : '' }));
            }}
          />
        </Field>
        <Field label="Search" className={`${styles.filter} ${styles.search}`}>
          <Input size="sm" type="search" value={search} maxLength={200} leading={<Search aria-hidden="true" />} placeholder="Message or field" onChange={(event) => setSearch(event.currentTarget.value)} />
        </Field>
      </div>
      {activeChips.length > 0 ? (
        <div className={styles.chips} aria-label="Active filters" role="group">
          {activeChips.map((chip) => (
            <button key={chip.id} type="button" className={styles.chip} data-active="true" onClick={chip.remove} aria-label={`Remove filter ${chip.label}`}>
              {chip.label}
              <X aria-hidden="true" />
            </button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setFilters({ ...DEFAULT_LOG_FILTERS, level: filters.level })}>
            Clear filters
          </Button>
        </div>
      ) : null}
      <p className={styles.liveStatus} aria-live="polite">
        {page.data === undefined ? '' : `${count}${notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}`}
      </p>
      {body}
    </SettingsCard>
  );
}
