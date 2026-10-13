/**
 * Calendar widget (§10.8, §10.7): agenda (default), week and month views over the calendars
 * selected in the widget config, date navigation within the synced window, event popovers,
 * "+" EventDialog, edit/delete with optimistic updates and toasts (Undo where reversible),
 * not-configured / reauth / error / stale states.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  CalendarPlus,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  List,
  Plus,
  RefreshCw,
  Rss,
  TriangleAlert,
  Unplug,
  UserRoundPlus,
} from 'lucide-react';
import type { Account, CalendarEvent, EventInput, EventUpdate } from '@portly/shared';
import { useAccounts } from '../../api/accounts.ts';
import {
  calendarSyncFailed,
  useCalendarEvents,
  useCalendars,
  useCreateEvent,
  useDeleteEvent,
  useSyncCalendars,
  useUpdateEvent,
} from '../../api/calendar.ts';
import { ApiError, isApiError } from '../../api/client.ts';
import { qk } from '../../api/keys.ts';
import { useSettings } from '../../api/settings.ts';
import { WidgetActions } from '../../grid/WidgetContext.tsx';
import { useFormatters } from '../../lib/format.ts';
import { safeHref } from '../../lib/openUrl.ts';
import { useNow } from '../../lib/useNow.ts';
import { ReconnectButton } from '../../ui/accounts/ReconnectButton.tsx';
import { Banner } from '../../ui/Banner.tsx';
import { Button, IconButton } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/Dialog.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState, StaleIndicator } from '../../ui/ErrorState.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { errorMessage, toast, toastError, toastUndo } from '../../ui/toast.ts';
import { SegmentedControl } from '../../ui/Toggles.tsx';
import { Tooltip } from '../../ui/Tooltip.tsx';
import type { WidgetProps } from '../types.ts';
import { AgendaView } from './AgendaView.tsx';
import { CalendarWidgetContext, type CalendarWidgetContextValue } from './context.tsx';
import { EventDialog } from './EventDialog.tsx';
import type { CalendarConfig } from './index.ts';
import { rangeLabel } from './labels.ts';
import {
  browserTimeZone,
  dateKey,
  defaultCalendarId,
  defaultFormValues,
  estimatedSyncedWindow,
  filterEvents,
  formTimes,
  formValuesFromEvent,
  sameEventTimes,
  shiftAnchor,
  viewRange,
  type CalendarView,
  type EventFormValues,
} from './model.ts';
import { MonthView } from './MonthView.tsx';
import { WeekView } from './WeekView.tsx';
import styles from './Calendar.module.css';

const ACCOUNTS_ROUTE = '#/settings/accounts';
const CALENDARS_ROUTE = '#/settings/calendars';

const VIEW_OPTIONS = [
  { value: 'agenda', label: 'Agenda', icon: List, iconOnly: true },
  { value: 'week', label: 'Week', icon: CalendarRange, iconOnly: true },
  { value: 'month', label: 'Month', icon: CalendarDays, iconOnly: true },
] as const;

interface DialogState {
  event: CalendarEvent | null;
  initial: EventFormValues;
}

function NotConfigured({ compact }: { compact: boolean }) {
  return (
    <EmptyState
      icon={CalendarPlus}
      compact={compact}
      title="No calendars yet"
      body="Connect Google, Outlook.com, Yahoo or a CalDAV server, or subscribe to an ICS link."
      action={
        <div className={styles.setupLinks}>
          <a className={styles.setupLink} href={safeHref(ACCOUNTS_ROUTE)}>
            <UserRoundPlus aria-hidden="true" />
            Connect an account
          </a>
          <a className={styles.setupLink} href={safeHref(`${CALENDARS_ROUTE}?focus=ics`)}>
            <Rss aria-hidden="true" />
            Add an ICS feed
          </a>
        </div>
      }
    />
  );
}

/**
 * No calendars in the list: an account whose calendars have not arrived (reauth → Reconnect;
 * error → its message; else the first sync is still running), or nothing set up at all.
 */
function NoCalendars({ accounts, compact }: { accounts: readonly Account[]; compact: boolean }) {
  const reauth = accounts.find((a) => a.status === 'reauth');
  if (reauth) {
    return <ErrorState error={new ApiError(409, 'reauth_required', `Reconnect ${reauth.label} to see its calendars`, undefined, reauth.id)} compact={compact} />;
  }
  if (accounts.length === 0) return <NotConfigured compact={compact} />;
  // Every account failing (none still syncing normally): say so instead of "waiting".
  const failing = accounts.every((a) => a.status !== 'ok') ? accounts.find((a) => a.status === 'error') : undefined;
  const link = (
    <a className={styles.setupLink} href={safeHref(failing ? ACCOUNTS_ROUTE : CALENDARS_ROUTE)}>
      {failing ? 'Account settings' : 'Calendar settings'}
    </a>
  );
  return failing ? (
    <EmptyState
      icon={TriangleAlert}
      compact={compact}
      title={`${failing.label} could not be reached`}
      body={failing.statusMessage ?? 'Its calendars appear once the account works again.'}
      action={link}
    />
  ) : (
    <EmptyState
      icon={RefreshCw}
      compact={compact}
      title="Waiting for your calendars"
      body={`Portly is syncing ${accounts.length === 1 ? accounts[0]!.label : 'your accounts'}. If nothing appears, check Settings › Calendars.`}
      action={link}
    />
  );
}

/** Events input → the update that restores the event as it was (Undo of an edit). */
function restorePatch(event: CalendarEvent, applied: EventUpdate): EventUpdate {
  return {
    title: event.title,
    ...(applied.start !== undefined
      ? { allDay: event.allDay, start: event.start, end: event.end, ...(event.timezone ? { timezone: event.timezone } : {}) }
      : {}),
    location: event.location,
    description: event.description,
  };
}

export default function CalendarWidget({ config, setConfig, size }: WidgetProps<CalendarConfig>) {
  const fmt = useFormatters();
  const settings = useSettings();
  const now = useNow(60_000);
  const today = dateKey(now);
  const tz = useMemo(() => browserTimeZone(), []);
  const client = useQueryClient();
  const compact = size.h <= 4;
  /** Tall enough for an inline reconnect banner above the events. */
  const roomy = size.h >= 7;

  const [anchorState, setAnchorState] = useState<string | null>(null);
  const anchor = anchorState ?? today;
  // Local view state so switching works immediately (and on the unsaved default layout); the
  // choice is also saved to the widget config.
  const [view, setView] = useState<CalendarView>(config.view);
  useEffect(() => setView(config.view), [config.view]);
  const range = viewRange(view, anchor, config.days, fmt.weekStartsOn);
  const synced = estimatedSyncedWindow(today);

  const accountsQuery = useAccounts();
  /** Accounts with the calendar capability switched on (their calendars appear after a sync). */
  const calendarAccounts = useMemo(
    () => (accountsQuery.data ?? []).filter((a) => a.capabilities.includes('calendar') && a.enabledCapabilities.includes('calendar')),
    [accountsQuery.data],
  );
  const calendarsQuery = useCalendars({
    pollWhileEmpty: calendarAccounts.some((a) => a.status === 'ok'),
    pollKey: calendarAccounts.map((a) => `${a.id}:${a.updatedAt}`).join(','),
  });
  const eventsQuery = useCalendarEvents({ from: range.from, to: range.to, tz }, { calendars: config.calendarIds });
  const sync = useSyncCalendars();
  const createMutation = useCreateEvent();
  const updateMutation = useUpdateEvent();
  const deleteMutation = useDeleteEvent();

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<CalendarEvent | null>(null);

  const calendarList = useMemo(() => calendarsQuery.data ?? [], [calendarsQuery.data]);
  const calendars = useMemo(() => new Map(calendarList.map((c) => [c.id, c] as const)), [calendarList]);
  const selected = useMemo(
    () => calendarList.filter((c) => (config.calendarIds === 'visible' ? c.visible : config.calendarIds.includes(c.id))),
    [calendarList, config.calendarIds],
  );
  const writable = useMemo(() => calendarList.filter((c) => c.writable), [calendarList]);
  const preferredCalendar = settings.data?.calendar.defaultCalendarId ?? null;

  // A finished background sync (new sync time or error on any calendar) refreshes the events and
  // the accounts (a sync can flag an account for reconnection).
  const syncStamp =
    calendarsQuery.data === undefined ? null : calendarList.map((c) => `${c.id}|${c.lastSyncedAt ?? ''}|${c.lastError ?? ''}`).join(',');
  const lastStamp = useRef<string | null>(null);
  useEffect(() => {
    if (syncStamp === null) return;
    const previous = lastStamp.current;
    lastStamp.current = syncStamp;
    if (previous === null || previous === syncStamp) return; // first load, or nothing new
    void client.invalidateQueries({ queryKey: ['calendar', 'events'] });
    void client.invalidateQueries({ queryKey: qk.accounts() });
  }, [client, syncStamp]);

  const openCreate = useCallback(
    (day?: string, hour?: number) => {
      setDialog({ event: null, initial: defaultFormValues(new Date(), defaultCalendarId(writable, preferredCalendar), day, hour) });
      setDialogOpen(true);
    },
    [writable, preferredCalendar],
  );

  const openEdit = useCallback((event: CalendarEvent) => {
    setDialog({ event, initial: formValuesFromEvent(event) });
    setDialogOpen(true);
  }, []);

  const context = useMemo<CalendarWidgetContextValue>(
    () => ({
      calendars,
      now,
      today,
      fmt,
      canCreate: writable.length > 0,
      createEvent: openCreate,
      editEvent: openEdit,
      deleteEvent: setDeleting,
    }),
    [calendars, now, today, fmt, writable.length, openCreate, openEdit],
  );

  const submitDialog = (values: EventFormValues) => {
    const current = dialog;
    setDialogOpen(false);
    const times = formTimes(values, tz);
    const editAgain = (event: CalendarEvent | null) => ({
      label: 'Edit again',
      onClick: () => {
        setDialog({ event, initial: values });
        setDialogOpen(true);
      },
    });

    if (!current?.event) {
      const input: EventInput = {
        calendarId: values.calendarId,
        title: values.title,
        ...times,
        ...(values.location ? { location: values.location } : {}),
        ...(values.description ? { description: values.description } : {}),
      };
      createMutation.mutateAsync(input).then(
        (created) => toastUndo(`“${created.title}” added`, { onUndo: () => deleteMutation.mutateAsync(created.id) }),
        (error: unknown) => toast.error(errorMessage(error, 'The event could not be added.'), { action: editAgain(null) }),
      );
      return;
    }

    const original = current.event;
    const patch: EventUpdate = {
      title: values.title,
      // Unchanged times are not sent: re-sending them would move the event into the browser's
      // zone at the provider (and rewrite every occurrence field) for a title-only edit.
      ...(sameEventTimes(original, times) ? {} : times),
      location: values.location || null,
      description: values.description || null,
    };
    updateMutation.mutateAsync({ id: original.id, patch }).then(
      (updated) =>
        toastUndo(`“${updated.title}” updated`, {
          onUndo: async () => void (await updateMutation.mutateAsync({ id: updated.id, patch: restorePatch(original, patch) })),
        }),
      (error: unknown) => toast.error(errorMessage(error, 'The event could not be saved.'), { action: editAgain(original) }),
    );
  };

  const runSync = () => {
    sync.mutate(undefined, { onError: (error) => toastError(error, 'Calendars could not be synced.') });
  };

  // ---- States ---------------------------------------------------------------

  // Warnings (e.g. shortened repeating events) are shown in settings only: the sync worked.
  const failing = selected.filter(calendarSyncFailed);
  const accounts = accountsQuery.data ?? [];
  const reauthAccounts: Account[] = accounts.filter((a) => a.status === 'reauth' && selected.some((c) => c.accountId === a.id));
  const allNeedReauth = selected.length > 0 && selected.every((c) => c.accountId !== null && reauthAccounts.some((a) => a.id === c.accountId));
  /** Nothing cached to show: the whole body is the reauth error state. */
  const reauthIsContent = allNeedReauth && reauthAccounts[0] !== undefined && (eventsQuery.data?.events.length ?? 0) === 0;
  /** Otherwise cached events stay visible with a Reconnect prompt (banner, or an icon when short). */
  const reauthPrompt = reauthAccounts.length > 0 && !reauthIsContent ? reauthAccounts[0] : undefined;

  const headerActions = (
    <WidgetActions>
      <span className={styles.headerActions}>
        {eventsQuery.data && calendarList.length > 0 && !isApiError(eventsQuery.error, 'not_configured') ? (
          <StaleIndicator updatedAt={eventsQuery.dataUpdatedAt} error={eventsQuery.isError ? eventsQuery.error : undefined} onRetry={() => void eventsQuery.refetch()} />
        ) : null}
        {!roomy && reauthPrompt ? (
          <Tooltip content={`Reconnect ${reauthPrompt.label}: its calendars are shown from the last sync.`}>
            <a className={styles.syncWarning} href={safeHref(ACCOUNTS_ROUTE)} aria-label={`Reconnect ${reauthPrompt.label} in account settings`}>
              <Unplug aria-hidden="true" />
            </a>
          </Tooltip>
        ) : null}
        {failing.length > 0 && reauthAccounts.length === 0 ? (
          <Tooltip content={`${failing.length === 1 ? `${failing[0]!.name} could not sync` : `${failing.length} calendars could not sync`}: ${failing[0]!.lastError}`}>
            <a className={styles.syncWarning} href={safeHref(CALENDARS_ROUTE)} aria-label={`${failing.length} calendar${failing.length === 1 ? '' : 's'} could not sync. Open calendar settings.`}>
              <TriangleAlert aria-hidden="true" />
            </a>
          </Tooltip>
        ) : null}
        {calendarList.length > 0 || calendarAccounts.length > 0 ? (
          <IconButton icon={RefreshCw} size="sm" aria-label="Sync calendars now" loading={sync.isPending} onClick={runSync} />
        ) : null}
        {writable.length > 0 ? <IconButton icon={Plus} size="sm" aria-label="New event" onClick={() => openCreate()} /> : null}
      </span>
    </WidgetActions>
  );

  let content: ReactNode;
  if (calendarsQuery.data === undefined) {
    content = calendarsQuery.isError ? (
      <ErrorState error={calendarsQuery.error} onRetry={() => void calendarsQuery.refetch()} compact={compact} />
    ) : (
      <SkeletonList rows={compact ? 2 : 4} />
    );
  } else if (calendarList.length === 0 || isApiError(eventsQuery.error, 'not_configured')) {
    // Which empty state applies depends on the accounts (connected but not synced yet, reauth…).
    content =
      accountsQuery.data === undefined && accountsQuery.isPending ? (
        <SkeletonList rows={compact ? 2 : 4} />
      ) : (
        <NoCalendars accounts={calendarAccounts} compact={compact} />
      );
  } else if (reauthIsContent && reauthAccounts[0]) {
    const account = reauthAccounts[0];
    content = (
      <ErrorState error={new ApiError(409, 'reauth_required', `Reconnect ${account.label}`, undefined, account.id)} compact={compact} />
    );
  } else if (selected.length === 0) {
    content = (
      <EmptyState
        icon={CalendarDays}
        compact={compact}
        title="No calendars selected"
        body="Choose calendars in this widget’s settings or mark some visible in Settings › Calendars."
        action={
          <a className={styles.setupLink} href={safeHref(CALENDARS_ROUTE)}>
            Calendar settings
          </a>
        }
      />
    );
  } else if (eventsQuery.data === undefined) {
    content = eventsQuery.isError ? (
      <ErrorState error={eventsQuery.error} onRetry={() => void eventsQuery.refetch()} compact={compact} />
    ) : (
      <SkeletonList rows={compact ? 2 : 4} />
    );
  } else {
    const events = filterEvents(eventsQuery.data.events, calendars, { calendarIds: config.calendarIds, showDeclined: config.showDeclined });
    const firstSync = selected.every((c) => c.lastSyncedAt === null && c.lastError === null) && events.length === 0;
    const month = anchor.slice(0, 7);
    content = firstSync ? (
      <EmptyState icon={RefreshCw} compact={compact} title="Syncing your calendars…" body="Events appear here in a moment." />
    ) : view === 'week' ? (
      <WeekView events={events} range={range} narrow={size.w <= 5} />
    ) : view === 'month' ? (
      <MonthView events={events} range={range} month={month} />
    ) : (
      <AgendaView events={events} range={range} compact={compact} />
    );
  }

  const showToolbar = calendarsQuery.data !== undefined && calendarList.length > 0 && !isApiError(eventsQuery.error, 'not_configured');
  const canPrev = range.from > synced.from;
  const canNext = range.to < synced.to;

  return (
    <CalendarWidgetContext.Provider value={context}>
      <div className={styles.root}>
        {headerActions}
        {showToolbar ? (
          <div className={styles.toolbar}>
            <div className={styles.nav}>
              <IconButton icon={ChevronLeft} size="sm" aria-label="Previous" disabled={!canPrev} onClick={() => setAnchorState(shiftAnchor(view, anchor, -1, config.days))} />
              <Button size="sm" variant="ghost" onClick={() => setAnchorState(null)} disabled={anchorState === null || anchorState === today}>
                Today
              </Button>
              <IconButton icon={ChevronRight} size="sm" aria-label="Next" disabled={!canNext} onClick={() => setAnchorState(shiftAnchor(view, anchor, 1, config.days))} />
            </div>
            <span className={styles.rangeLabel} aria-live="polite">
              {rangeLabel(view, range, anchor, fmt)}
            </span>
            <SegmentedControl<CalendarView>
              size="sm"
              aria-label="Calendar view"
              value={view}
              options={VIEW_OPTIONS}
              onValueChange={(next) => {
                setView(next);
                void setConfig({ view: next });
              }}
            />
          </div>
        ) : null}
        {reauthPrompt && roomy ? (
          <div className={styles.notice}>
            <Banner tone="warning" title={`Reconnect ${reauthPrompt.label}`} actions={<ReconnectButton accountId={reauthPrompt.id} />}>
              {size.w >= 5 ? 'Its calendars are shown from the last sync.' : null}
            </Banner>
          </div>
        ) : null}
        <div className={styles.content}>{content}</div>
      </div>

      {dialog ? (
        <EventDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          event={dialog.event}
          initial={dialog.initial}
          writableCalendars={writable}
          calendars={calendars}
          onSubmit={submitDialog}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={deleting ? `Delete “${deleting.title}”?` : 'Delete event?'}
        description={
          deleting?.recurring
            ? 'Only this occurrence is deleted; the rest of the series stays.'
            : `The event is deleted from ${deleting ? (calendars.get(deleting.calendarId)?.name ?? 'its calendar') : 'its calendar'}.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          const target = deleting;
          if (!target) return;
          try {
            await deleteMutation.mutateAsync(target.id);
            toast.success(`“${target.title}” deleted`);
          } catch (error) {
            toastError(error, 'The event could not be deleted.');
            throw error;
          }
        }}
      />
    </CalendarWidgetContext.Provider>
  );
}
