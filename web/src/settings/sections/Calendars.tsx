/**
 * Settings › Calendars (§10.8): calendars grouped by account with visibility, color override,
 * "read-only in Portly", last sync and last error per calendar; ICS subscriptions (add / edit /
 * remove — the feed URL is write-only, only its host is shown); sync interval, default calendar
 * for new events and "Sync now".
 */
import { useRef, useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { CircleAlert, Pencil, Plus, RefreshCw, RotateCcw, Rss, Trash, TriangleAlert, UserRoundPlus } from 'lucide-react';
import { IcsCreateSchema, IcsUpdateSchema, type Account, type Calendar } from '@portly/shared';
import { useAccounts } from '../../api/accounts.ts';
import {
  calendarSyncFailed,
  calendarSyncIssue,
  useAddIcs,
  useCalendars,
  useDeleteCalendar,
  useSyncCalendars,
  useUpdateCalendar,
  useUpdateIcs,
} from '../../api/calendar.ts';
import { isApiError } from '../../api/client.ts';
import { useSettings, useUpdateSettings } from '../../api/settings.ts';
import { ACCOUNT_KIND_LABELS } from '../../ui/accounts/accountKinds.ts';
import { accountColor } from '../../ui/accounts/AccountBadge.tsx';
import { ReconnectButton } from '../../ui/accounts/ReconnectButton.tsx';
import { Badge } from '../../ui/Badge.tsx';
import { Button, IconButton } from '../../ui/Button.tsx';
import { ColorPicker, ColorPickerPopover } from '../../ui/ColorPicker.tsx';
import { ConfirmDialog, Dialog } from '../../ui/Dialog.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input, Select } from '../../ui/Input.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { FormFooter, SettingsCard } from '../../ui/Section.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { errorMessage, toast, toastError } from '../../ui/toast.ts';
import { Checkbox, Switch } from '../../ui/Toggles.tsx';
import { safeColor } from '../../lib/color.ts';
import { safeHref } from '../../lib/openUrl.ts';
import styles from '../../widgets/calendar/CalendarsSettings.module.css';
import shared from '../../styles/settings.module.css';
import { clearHashFocus, hashFocus } from '../../app/router.ts';

const INTERVALS = [5, 10, 15, 30, 60] as const;
const ACCOUNTS_ROUTE = '#/settings/accounts';

/** First message per field of a 422 `details` list. */
function fieldErrors(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(details)) return out;
  for (const issue of details) {
    if (!issue || typeof issue !== 'object') continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    const key = typeof path === 'string' ? path.split('.')[0] : Array.isArray(path) ? String(path[0]) : undefined;
    if (key && typeof message === 'string' && !(key in out)) out[key] = message;
  }
  return out;
}

export default function CalendarsSettings() {
  const calendars = useCalendars();
  const accounts = useAccounts();

  if (calendars.data === undefined || accounts.data === undefined) {
    const error = calendars.error ?? accounts.error;
    return (
      <div className={shared.stack}>
        {error ? (
          <ErrorState
            error={error}
            onRetry={() => {
              void calendars.refetch();
              void accounts.refetch();
            }}
          />
        ) : (
          <SkeletonList rows={4} />
        )}
      </div>
    );
  }

  const calendarAccounts = accounts.data.filter((a) => a.capabilities.includes('calendar'));
  const ics = calendars.data.filter((c) => c.source === 'ics');

  return (
    <div className={shared.stack}>
      <SyncCard calendars={calendars.data} hasAccounts={calendarAccounts.some((a) => a.enabledCapabilities.includes('calendar'))} />
      {calendarAccounts.length === 0 ? (
        <SettingsCard title="Accounts">
          <EmptyState
            icon={UserRoundPlus}
            title="No calendar accounts"
            body="Connect Google, Outlook.com, Yahoo or a CalDAV server to see their calendars here."
            action={
              <a className={styles.link} href={safeHref(ACCOUNTS_ROUTE)}>
                <UserRoundPlus aria-hidden="true" />
                Open accounts
              </a>
            }
          />
        </SettingsCard>
      ) : (
        calendarAccounts.map((account) => (
          <AccountCalendars key={account.id} account={account} calendars={calendars.data.filter((c) => c.accountId === account.id)} />
        ))
      )}
      <IcsCard calendars={ics} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function SyncCard({ calendars, hasAccounts }: { calendars: Calendar[]; hasAccounts: boolean }) {
  const settings = useSettings();
  const update = useUpdateSettings();
  const sync = useSyncCalendars();
  const current = settings.data?.calendar;
  const writable = calendars.filter((c) => c.writable);
  const lastSynced = calendars.reduce<string | null>((max, c) => (c.lastSyncedAt && (!max || c.lastSyncedAt > max) ? c.lastSyncedAt : max), null);
  const failing = calendars.filter(calendarSyncFailed).length;
  const warnings = calendars.filter((c) => calendarSyncIssue(c)?.level === 'warning').length;

  const runSync = async () => {
    try {
      const result = await sync.mutateAsync();
      const errors = result.filter(calendarSyncFailed).length;
      if (errors > 0) toast.warning(`Synced, but ${errors === 1 ? '1 calendar has' : `${errors} calendars have`} a problem.`);
      else toast.success('Calendars are up to date.');
    } catch (error) {
      toastError(error, 'Calendars could not be synced.');
    }
  };

  return (
    <SettingsCard
      title="Sync"
      description="Account calendars sync on this interval; ICS subscriptions every 30 minutes. Portly keeps 30 days back and a year ahead."
      actions={
        <Button icon={RefreshCw} loading={sync.isPending} onClick={() => void runSync()} disabled={calendars.length === 0 && !hasAccounts}>
          Sync now
        </Button>
      }
    >
      <div className={styles.syncGrid}>
        <Field label="Sync interval">
          <Select
            value={String(current?.syncIntervalMin ?? 5)}
            disabled={!current}
            onChange={(e) => update.mutate({ calendar: { syncIntervalMin: Number(e.currentTarget.value) } })}
            options={INTERVALS.map((m) => ({ value: String(m), label: m === 60 ? 'Every hour' : `Every ${m} minutes` }))}
          />
        </Field>
        <Field label="Default calendar for new events" help={writable.length === 0 ? 'Connect Google or Outlook.com to add events.' : undefined}>
          <Select
            value={current?.defaultCalendarId && writable.some((c) => c.id === current.defaultCalendarId) ? current.defaultCalendarId : ''}
            disabled={!current || writable.length === 0}
            onChange={(e) => update.mutate({ calendar: { defaultCalendarId: e.currentTarget.value || null } })}
          >
            <option value="">Automatic (primary calendar)</option>
            {writable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className={styles.hint}>
        {lastSynced ? (
          <>
            Last sync <RelativeTime date={lastSynced} />.
          </>
        ) : calendars.length > 0 || hasAccounts ? (
          'Waiting for the first sync…'
        ) : (
          'Nothing to sync yet.'
        )}
        {failing > 0 ? ` ${failing === 1 ? '1 calendar has' : `${failing} calendars have`} a sync problem (see below).` : ''}
        {warnings > 0 ? ` ${warnings === 1 ? '1 calendar has' : `${warnings} calendars have`} a warning (see below).` : ''}
      </p>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Calendar rows
// ---------------------------------------------------------------------------

/** Where a calendar's own color comes from, for the "reset color" action. */
function colorSourceLabel(calendar: Calendar): string {
  if (calendar.source === 'ics') return 'default';
  if (calendar.source === 'google') return 'Google';
  if (calendar.source === 'microsoft') return 'Outlook.com';
  return 'provider';
}

function CalendarRow({ calendar, extraActions }: { calendar: Calendar; extraActions?: ReactNode }) {
  const update = useUpdateCalendar();
  const patch = (body: Parameters<typeof update.mutate>[0]) =>
    update.mutate(body, { onError: (error) => toastError(error, `${calendar.name} could not be updated.`) });
  const issue = calendarSyncIssue(calendar);
  const customColor = Boolean(calendar.colorOverride);

  return (
    <li className={styles.row}>
      <ColorPickerPopover
        label={`${calendar.name} color${customColor ? ' (custom)' : ''}`}
        size="sm"
        value={calendar.color}
        onChange={(color) => patch({ id: calendar.id, colorOverride: color })}
      />
      <div className={styles.main}>
        <div className={styles.name}>
          <span>{calendar.name}</span>
          {calendar.isPrimary ? <Badge tone="accent">Primary</Badge> : null}
          {!calendar.providerWritable && calendar.source !== 'ics' ? <Badge>Read-only</Badge> : null}
        </div>
        <div className={styles.meta}>
          {calendar.displayUrl ? <span>{calendar.displayUrl}</span> : null}
          <span>
            {calendar.lastSyncedAt ? (
              <>
                Synced <RelativeTime date={calendar.lastSyncedAt} />
              </>
            ) : calendar.lastError ? (
              'Never synced'
            ) : (
              'Waiting for the first sync'
            )}
          </span>
          {customColor ? (
            <span className={styles.customColor}>
              Custom color
              <button
                type="button"
                className={styles.inlineAction}
                aria-label={`Reset ${calendar.name} to the ${colorSourceLabel(calendar)} color`}
                title={`Use the ${colorSourceLabel(calendar)} color again`}
                onClick={() => patch({ id: calendar.id, colorOverride: null })}
              >
                <RotateCcw aria-hidden="true" />
                Reset
              </button>
            </span>
          ) : null}
        </div>
        {issue ? (
          <p className={issue.level === 'warning' ? styles.warning : styles.error} role="status">
            {issue.level === 'warning' ? <TriangleAlert aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
            {issue.level === 'warning' ? <span className="hb-visually-hidden">Warning: </span> : null}
            <span>{issue.message}</span>
          </p>
        ) : null}
      </div>
      <div className={styles.controls}>
        {calendar.providerWritable ? (
          <Checkbox
            label="Read-only here"
            checked={calendar.userReadOnly}
            onCheckedChange={(on) => patch({ id: calendar.id, userReadOnly: on })}
          />
        ) : null}
        <Switch size="sm" label="Visible" checked={calendar.visible} onCheckedChange={(on) => patch({ id: calendar.id, visible: on })} />
        {extraActions}
      </div>
    </li>
  );
}

function AccountCalendars({ account, calendars }: { account: Account; calendars: Calendar[] }) {
  const enabled = account.enabledCapabilities.includes('calendar');
  return (
    <SettingsCard
      title={
        <span className={styles.cardTitle} style={{ '--event-color': safeColor(accountColor(account), '#64748b') } as CSSProperties}>
          <span className={styles.accountDot} aria-hidden="true" />
          {account.label}
        </span>
      }
      description={`${ACCOUNT_KIND_LABELS[account.kind]}${account.email && account.email !== account.label ? ` · ${account.email}` : ''}${
        account.kind === 'yahoo' || account.kind === 'caldav' ? ' · read-only in this version' : ''
      }`}
      actions={
        account.status === 'reauth' ? (
          <ReconnectButton accountId={account.id} />
        ) : account.status === 'error' ? (
          <Badge tone="danger">Error</Badge>
        ) : null
      }
    >
      {!enabled ? (
        <p className={styles.hint}>
          Calendar is switched off for this account. Turn it on in <a href={safeHref(ACCOUNTS_ROUTE)}>Accounts</a>.
        </p>
      ) : calendars.length === 0 ? (
        <p className={styles.hint}>{account.status === 'ok' ? 'No calendars yet — they appear after the first sync.' : account.statusMessage ?? 'This account needs attention.'}</p>
      ) : (
        <ul className={styles.list} aria-label={`${account.label} calendars`}>
          {calendars.map((calendar) => (
            <CalendarRow key={calendar.id} calendar={calendar} />
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// ICS subscriptions
// ---------------------------------------------------------------------------

function IcsCard({ calendars }: { calendars: Calendar[] }) {
  const remove = useDeleteCalendar();
  const [editing, setEditing] = useState<Calendar | null>(null);
  const [removing, setRemoving] = useState<Calendar | null>(null);

  return (
    <SettingsCard
      title={
        <span className={styles.cardTitle}>
          <Rss aria-hidden="true" width={16} height={16} />
          Subscriptions (ICS)
        </span>
      }
      description="Read-only calendars from an ICS or webcal link, such as Proton Calendar share links, Yahoo public ICS links or published Outlook calendars. The link stays encrypted on this PC; only its host is shown."
    >
      {calendars.length > 0 ? (
        <ul className={styles.list} aria-label="ICS subscriptions">
          {calendars.map((calendar) => (
            <CalendarRow
              key={calendar.id}
              calendar={calendar}
              extraActions={
                <>
                  <IconButton icon={Pencil} size="sm" aria-label={`Edit ${calendar.name}`} onClick={() => setEditing(calendar)} />
                  <IconButton icon={Trash} size="sm" aria-label={`Remove ${calendar.name}`} onClick={() => setRemoving(calendar)} />
                </>
              }
            />
          ))}
        </ul>
      ) : null}
      <AddIcsForm />
      <EditIcsDialog calendar={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing ? `Remove “${removing.name}”?` : 'Remove subscription?'}
        description="Portly forgets the link and its cached events. The calendar itself is not affected."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          try {
            await remove.mutateAsync(removing.id);
            toast.success(`${removing.name} removed.`);
          } catch (error) {
            toastError(error, 'The subscription could not be removed.');
            throw error;
          }
        }}
      />
    </SettingsCard>
  );
}

function AddIcsForm() {
  const add = useAddIcs();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = IcsCreateSchema.safeParse({ name, url, color });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0]);
        if (!(key in next)) next[key] = key === 'url' ? 'Enter an https://, http:// or webcal:// link.' : key === 'name' ? 'Enter a name (up to 200 characters).' : issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    try {
      const created = await add.mutateAsync(parsed.data);
      toast.success(`${created.name} added.`);
      setName('');
      setUrl('');
      setColor(null);
    } catch (error) {
      const fields = isApiError(error) ? fieldErrors(error.details) : {};
      if (Object.keys(fields).length > 0) setErrors(fields);
      else setErrors({ url: errorMessage(error, 'The subscription could not be added.') });
    }
  };

  // Arrived from "Add an ICS feed" (#/settings/calendars?focus=ics): start in the link field.
  const formRef = useRef<HTMLFormElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (hashFocus() !== 'ics') return;
    clearHashFocus();
    formRef.current?.scrollIntoView({ block: 'center' });
    urlRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <form ref={formRef} className={styles.addForm} onSubmit={(e) => void submit(e)} noValidate aria-label="Add an ICS subscription">
      <div className={styles.addRow}>
        <Field label="Name" error={errors.name} required>
          <Input value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={220} placeholder="Holidays" autoComplete="off" />
        </Field>
        <Field label="Calendar link (ICS or webcal)" error={errors.url} required help="Fetched once now to check that it is a calendar.">
          <Input
            ref={urlRef}
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            placeholder="https://… or webcal://…"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
      </div>
      <Field label="Color (optional)">
        <ColorPicker value={color} onChange={setColor} onClear={() => setColor(null)} />
      </Field>
      <FormFooter status={add.isPending ? 'Checking the link…' : null}>
        <Button type="submit" variant="primary" icon={Plus} loading={add.isPending}>
          Add subscription
        </Button>
      </FormFooter>
    </form>
  );
}

function EditIcsDialog({ calendar, onClose }: { calendar: Calendar | null; onClose: () => void }) {
  const update = useUpdateIcs();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [openFor, setOpenFor] = useState<string | null>(null);

  // Reset the form whenever a different calendar is opened.
  if (calendar && openFor !== calendar.id) {
    setOpenFor(calendar.id);
    setName(calendar.name);
    setUrl('');
    setErrors({});
  }

  const body = useMemo(() => {
    const out: { name?: string; url?: string } = {};
    if (calendar && name.trim() !== calendar.name) out.name = name;
    if (url.trim() !== '') out.url = url;
    return out;
  }, [calendar, name, url]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!calendar) return;
    const parsed = IcsUpdateSchema.safeParse(body);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0]);
        if (!(key in next)) next[key] = key === 'url' ? 'Enter an https://, http:// or webcal:// link.' : 'Enter a name (up to 200 characters).';
      }
      setErrors(next);
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      onClose();
      return;
    }
    try {
      await update.mutateAsync({ id: calendar.id, ...parsed.data });
      toast.success('Subscription updated.');
      onClose();
    } catch (error) {
      const fields = isApiError(error) ? fieldErrors(error.details) : {};
      if (Object.keys(fields).length > 0) setErrors(fields);
      else setErrors({ url: errorMessage(error, 'The subscription could not be updated.') });
    }
  };

  return (
    <Dialog
      open={calendar !== null}
      onOpenChange={(open) => {
        if (!open) {
          setOpenFor(null);
          onClose();
        }
      }}
      title="Edit subscription"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="hb-edit-ics" loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="hb-edit-ics" className={styles.addForm} style={{ borderTop: 0, paddingTop: 0 }} onSubmit={(e) => void save(e)} noValidate>
        <Field label="Name" error={errors.name} required>
          <Input value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={220} autoComplete="off" />
        </Field>
        <Field label="New link" error={errors.url} help={`Current link: ${calendar?.displayUrl ?? 'hidden'}. Leave empty to keep it.`}>
          <Input value={url} onChange={(e) => setUrl(e.currentTarget.value)} placeholder="https://… or webcal://…" inputMode="url" spellCheck={false} autoComplete="off" />
        </Field>
      </form>
    </Dialog>
  );
}
