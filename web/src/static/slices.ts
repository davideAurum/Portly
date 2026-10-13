/**
 * The persisted state of the static backend: slice names and stored shapes shared by every
 * handler module. Handlers read a slice with the accessor, mutate the returned object and
 * `ctx.state.commit(SLICE.x)`. Image bytes are not in slices: they live in the blob store
 * (`StoredBlob`, kind `upload` or `icon`), slices hold only their metadata.
 *
 * Every accessor checks the stored shape the first time it sees a slice object (after startup or
 * a reload from another tab) and replaces a value of the wrong shape — corrupt, or written by an
 * incompatible build — with a repaired or empty one, so a bad record can never throw out of a
 * handler or keep the backend from starting.
 *
 * Export (`GET /api/export`) reads settings, profiles, bookmarks, uploads and icons. The Todoist
 * token, the pre-import backups, accounts and their tokens, the OAuth client, pending sign-ins and
 * the calendar cache are never exported (and an import never touches them).
 */
import {
  ACCOUNT_STATUSES,
  CALENDAR_SOURCES,
  CAPABILITIES,
  SETTINGS_NAMESPACES,
  SettingsSchema,
  defaultSettings,
  settingsNamespaceSchema,
  type AccountStatus,
  type Capability,
  type Profile,
  type Settings,
} from '@portly/shared';
import type { StaticContext } from './context.ts';
import type { CalendarRow, EventRow } from './lib/calendarRecords.ts';

export const SLICE = Object.freeze({
  settings: 'settings',
  profiles: 'profiles',
  bookmarks: 'bookmarks',
  uploads: 'uploads',
  icons: 'icons',
  todoistToken: 'todoist-token',
  backups: 'backups',
  accounts: 'accounts',
  accountTokens: 'account-tokens',
  oauthClients: 'oauth-clients',
  oauthStates: 'oauth-states',
  calendars: 'calendars',
  calendarEvents: 'calendar-events',
  calendarSync: 'calendar-sync',
});

// ---------------------------------------------------------------------------
// Shape checks
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasId(value: unknown): value is Row & { id: string } {
  return isRow(value) && typeof value.id === 'string';
}

/** Slice objects already checked (identity changes whenever a slice is replaced or reloaded). */
const checkedSlices = new WeakSet<object>();

/**
 * The slice, initialized with `init()` when absent; a stored value that fails `check` is replaced
 * (in memory; the next commit persists it) with `repair(value)` or `init()`, with a warning.
 */
function checkedSlice<T extends object>(
  ctx: StaticContext,
  name: string,
  init: () => T,
  check: (value: unknown) => boolean,
  repair?: (value: unknown) => T,
): T {
  const value = ctx.state.get<unknown>(name, init);
  if (isRow(value) || Array.isArray(value)) {
    if (checkedSlices.has(value)) return value as T;
    if (check(value)) {
      checkedSlices.add(value);
      return value as T;
    }
  }
  const replaced = repair?.(value) ?? init();
  console.warn(`[Portly] Stored "${name}" data had an unexpected shape and was repaired`);
  checkedSlices.add(replaced);
  return ctx.state.set(name, replaced);
}

/** An array slice whose rows must pass `isValid`; other rows are dropped. */
function rowsSlice<T>(ctx: StaticContext, name: string, isValid: (row: unknown) => boolean): T[] {
  return checkedSlice<T[]>(
    ctx,
    name,
    () => [],
    (value) => Array.isArray(value) && value.every(isValid),
    (value) => (Array.isArray(value) ? (value.filter(isValid) as T[]) : []),
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The full Settings object. Like the server's loader, a namespace that fails validation falls
 * back to its defaults on its own instead of discarding everything (`activeProfileId` included:
 * an invalid pointer becomes null). Never throws.
 */
export function getSettings(ctx: StaticContext): Settings {
  const slice = ctx.state.get<unknown>(SLICE.settings, () => defaultSettings());
  const whole = SettingsSchema.safeParse(slice);
  if (whole.success) return ctx.state.set(SLICE.settings, whole.data);
  const raw = isRow(slice) ? slice : {};
  const repaired: Record<string, unknown> = {};
  for (const ns of SETTINGS_NAMESPACES) {
    const parsed = settingsNamespaceSchema(ns).safeParse(raw[ns]);
    if (parsed.success) repaired[ns] = parsed.data;
    else {
      repaired[ns] = settingsNamespaceSchema(ns).parse(undefined);
      console.warn(`[Portly] Stored settings "${ns}" were invalid and fell back to the defaults`);
    }
  }
  const result = SettingsSchema.safeParse(repaired);
  return ctx.state.set(SLICE.settings, result.success ? result.data : defaultSettings());
}

export function setSettings(ctx: StaticContext, settings: Settings): Settings {
  return ctx.state.set(SLICE.settings, settings);
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** A profile row: the API shape plus timestamps (the server orders ties by createdAt). */
export interface StoredProfile {
  id: string;
  name: string;
  sort: number;
  layout: Profile['layout'];
  createdAt: number;
  updatedAt: number;
}

function isProfileRow(row: unknown): boolean {
  return hasId(row) && isRow(row.layout) && Array.isArray(row.layout.items) && row.layout.items.every(isRow);
}

export function getProfiles(ctx: StaticContext): StoredProfile[] {
  return rowsSlice<StoredProfile>(ctx, SLICE.profiles, isProfileRow);
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

export interface StoredBookmarkGroup {
  id: string;
  name: string;
  sort: number;
  color: string | null;
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StoredBookmark {
  id: string;
  groupId: string;
  title: string;
  url: string;
  sort: number;
  iconMode: 'auto' | 'custom' | 'letter';
  /** Custom: an icon blob id. Auto: a synthetic `fav:<host>` id (see favicon.ts) or null. */
  iconId: string | null;
  letterColor: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BookmarksSlice {
  groups: StoredBookmarkGroup[];
  bookmarks: StoredBookmark[];
}

export function getBookmarks(ctx: StaticContext): BookmarksSlice {
  const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value.filter(hasId) : []);
  return checkedSlice<BookmarksSlice>(
    ctx,
    SLICE.bookmarks,
    () => ({ groups: [], bookmarks: [] }),
    (value) =>
      isRow(value) && Array.isArray(value.groups) && value.groups.every(hasId) && Array.isArray(value.bookmarks) && value.bookmarks.every(hasId),
    (value) => ({
      groups: rows(isRow(value) ? value.groups : undefined) as StoredBookmarkGroup[],
      bookmarks: rows(isRow(value) ? value.bookmarks : undefined) as StoredBookmark[],
    }),
  );
}

// ---------------------------------------------------------------------------
// Images: uploads (theme backgrounds) and custom icons
// ---------------------------------------------------------------------------

/** Metadata of an upload whose bytes are blob `kind: 'upload'` with the same id. */
export interface StoredUploadMeta {
  id: string;
  type: string;
  createdAt: number;
}

export function getUploads(ctx: StaticContext): StoredUploadMeta[] {
  return rowsSlice<StoredUploadMeta>(ctx, SLICE.uploads, hasId);
}

/** Metadata of a custom bookmark icon whose bytes are blob `kind: 'icon'` with the same id. */
export interface StoredIconMeta {
  id: string;
  type: string;
  width: number | null;
  createdAt: number;
  /** Set when no bookmark references it any more; kept ≥ 1 h for Undo, then deleted. */
  orphanedAt: number | null;
}

export function getIcons(ctx: StaticContext): StoredIconMeta[] {
  return rowsSlice<StoredIconMeta>(ctx, SLICE.icons, hasId);
}

/** How long an unreferenced custom icon or upload is kept (mirrors the server's grace period). */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Todoist token (never exported)
// ---------------------------------------------------------------------------

export interface TodoistTokenSlice {
  token: string | null;
  /** Bumped on every token change so caches keyed by it are never served across tokens. */
  generation: number;
}

export function getTodoistToken(ctx: StaticContext): TodoistTokenSlice {
  return checkedSlice<TodoistTokenSlice>(
    ctx,
    SLICE.todoistToken,
    () => ({ token: null, generation: 0 }),
    (value) => isRow(value) && (value.token === null || typeof value.token === 'string') && Number.isFinite(value.generation),
    // Keep the generation moving forward so token-keyed caches are never reused.
    (value) => ({ token: null, generation: isRow(value) && Number.isFinite(value.generation) ? Number(value.generation) + 1 : 1 }),
  );
}

// ---------------------------------------------------------------------------
// Pre-import backups (never exported)
// ---------------------------------------------------------------------------

/**
 * One pre-import snapshot. The slice holds only this small index; the export document itself is
 * the JSON string stored under {@link backupKey}`(id)`, outside the `slice:` namespace, so it is
 * never loaded at startup or on a cross-tab reload — only when it is downloaded.
 */
export interface BackupEntry {
  id: string;
  /** When the import replaced everything (epoch ms). */
  at: number;
  /** Length of the stored export document (characters), for the UI. */
  bytes: number;
}

export interface BackupsSlice {
  entries: BackupEntry[];
}

export const MAX_BACKUPS = 3;

export const BACKUP_KEY_PREFIX = 'backup:';

/** Storage key of a backup's export document. */
export function backupKey(id: string): string {
  return `${BACKUP_KEY_PREFIX}${id}`;
}

function isBackupEntry(entry: unknown): boolean {
  return hasId(entry) && Number.isFinite(entry.at) && Number.isFinite(entry.bytes);
}

export function getBackups(ctx: StaticContext): BackupsSlice {
  return checkedSlice<BackupsSlice>(
    ctx,
    SLICE.backups,
    () => ({ entries: [] }),
    (value) => isRow(value) && Array.isArray(value.entries) && value.entries.every(isBackupEntry),
    (value) => ({ entries: (isRow(value) && Array.isArray(value.entries) ? value.entries.filter(isBackupEntry) : []) as BackupEntry[] }),
  );
}

// ---------------------------------------------------------------------------
// Accounts (Microsoft only in the static build; never exported)
// ---------------------------------------------------------------------------

/** An account row (the server's `accounts` row, minus the config the OAuth kinds never use). */
export interface StoredAccount {
  id: string;
  kind: 'microsoft';
  label: string;
  email: string | null;
  /** Provider subject (`oid`): reconnects match on it. */
  externalId: string;
  color: string | null;
  capabilities: Capability[];
  enabledCapabilities: Capability[];
  grantedScopes: string[];
  status: AccountStatus;
  statusMessage: string | null;
  sort: number;
  createdAt: number;
  updatedAt: number;
}

function isCapabilityList(value: unknown): boolean {
  return Array.isArray(value) && value.every((c) => (CAPABILITIES as readonly unknown[]).includes(c));
}

function isAccountRow(row: unknown): boolean {
  return (
    hasId(row) &&
    row.kind === 'microsoft' &&
    typeof row.label === 'string' &&
    typeof row.externalId === 'string' &&
    isCapabilityList(row.capabilities) &&
    isCapabilityList(row.enabledCapabilities) &&
    (ACCOUNT_STATUSES as readonly unknown[]).includes(row.status) &&
    Number.isFinite(row.sort)
  );
}

export function getAccounts(ctx: StaticContext): StoredAccount[] {
  return rowsSlice<StoredAccount>(ctx, SLICE.accounts, isAccountRow);
}

/**
 * An account's OAuth tokens, kept apart from the account rows. Access tokens are stored too, so
 * every tab of the site shares one (refreshes are serialized across tabs with a Web Lock).
 */
export interface StoredAccountTokens {
  refreshToken: string;
  accessToken: string | null;
  /**
   * When to refresh the access token (epoch ms): 5 minutes before it expires, or halfway through
   * a shorter lifetime (the server's rule); 0 when there is no access token.
   */
  accessRefreshAt: number;
  /**
   * When the sign-in itself ends (epoch ms): Microsoft gives single-page apps refresh tokens that
   * stop working 24 hours after the interactive sign-in, however often they are used.
   */
  sessionExpiresAt: number;
  /** Last automatic (`prompt=none`) sign-in attempt for this account, epoch ms. */
  silentAttemptAt: number | null;
}

export type AccountTokensSlice = Record<string, StoredAccountTokens>;

function isTokenRecord(value: unknown): boolean {
  return (
    isRow(value) &&
    typeof value.refreshToken === 'string' &&
    (value.accessToken === null || typeof value.accessToken === 'string') &&
    Number.isFinite(value.accessRefreshAt) &&
    Number.isFinite(value.sessionExpiresAt) &&
    (value.silentAttemptAt === null || Number.isFinite(value.silentAttemptAt))
  );
}

export function getAccountTokens(ctx: StaticContext): AccountTokensSlice {
  return checkedSlice<AccountTokensSlice>(
    ctx,
    SLICE.accountTokens,
    () => ({}),
    (value) => isRow(value) && Object.values(value).every(isTokenRecord),
    (value) => (isRow(value) ? (Object.fromEntries(Object.entries(value).filter(([, v]) => isTokenRecord(v))) as AccountTokensSlice) : {}),
  );
}

// ---------------------------------------------------------------------------
// OAuth client and pending sign-ins (never exported)
// ---------------------------------------------------------------------------

/** The Microsoft app registration (Application (client) ID); public clients have no secret. */
export interface OAuthClientsSlice {
  microsoft: { clientId: string; updatedAt: number } | null;
}

export function getOAuthClients(ctx: StaticContext): OAuthClientsSlice {
  const isClient = (value: unknown) => value === null || (isRow(value) && typeof value.clientId === 'string' && Number.isFinite(value.updatedAt));
  return checkedSlice<OAuthClientsSlice>(
    ctx,
    SLICE.oauthClients,
    () => ({ microsoft: null }),
    (value) => isRow(value) && isClient(value.microsoft),
  );
}

/** A pending authorization (the server's `oauth_states` row). */
export interface StoredOAuthState {
  state: string;
  provider: 'microsoft';
  codeVerifier: string;
  /** Account being reconnected, or null for a new connection. */
  accountId: string | null;
  returnTo: string;
  /** Started automatically (`prompt=none`): failures are not reported to the user. */
  silent: boolean;
  createdAt: number;
  expiresAt: number;
}

function isOAuthStateRow(row: unknown): boolean {
  return (
    isRow(row) &&
    typeof row.state === 'string' &&
    row.provider === 'microsoft' &&
    typeof row.codeVerifier === 'string' &&
    typeof row.returnTo === 'string' &&
    typeof row.silent === 'boolean' &&
    Number.isFinite(row.expiresAt)
  );
}

export function getOAuthStates(ctx: StaticContext): StoredOAuthState[] {
  return rowsSlice<StoredOAuthState>(ctx, SLICE.oauthStates, isOAuthStateRow);
}

// ---------------------------------------------------------------------------
// Calendar cache (Outlook.com calendars synced from Graph; never exported)
// ---------------------------------------------------------------------------

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isFlag(value: unknown): boolean {
  return value === 0 || value === 1;
}

function isCalendarRow(row: unknown): boolean {
  return (
    hasId(row) &&
    typeof row.account_id === 'string' &&
    (CALENDAR_SOURCES as readonly unknown[]).includes(row.source) &&
    typeof row.remote_id === 'string' &&
    typeof row.name === 'string' &&
    isNullableString(row.color) &&
    isNullableString(row.color_override) &&
    isFlag(row.provider_writable) &&
    isFlag(row.user_read_only) &&
    isFlag(row.visible) &&
    isFlag(row.is_primary) &&
    Number.isFinite(row.sort) &&
    (row.last_synced_at === null || Number.isFinite(row.last_synced_at)) &&
    isNullableString(row.last_error)
  );
}

/** Calendars of the Outlook.com accounts (the server's `calendars` rows; no ICS feeds here). */
export function getCalendars(ctx: StaticContext): CalendarRow[] {
  return rowsSlice<CalendarRow>(ctx, SLICE.calendars, isCalendarRow);
}

function isEventRow(row: unknown): boolean {
  return (
    hasId(row) &&
    typeof row.calendar_id === 'string' &&
    typeof row.remote_id === 'string' &&
    typeof row.title === 'string' &&
    typeof row.start === 'string' &&
    typeof row.end === 'string' &&
    isFlag(row.all_day) &&
    isFlag(row.editable) &&
    Number.isFinite(row.updated_at)
  );
}

/** Cached events by calendar id (the server's `events` rows of each calendar's sync window). */
export type CalendarEventsSlice = Record<string, EventRow[]>;

export function getCalendarEvents(ctx: StaticContext): CalendarEventsSlice {
  const isList = (value: unknown) => Array.isArray(value) && value.every(isEventRow);
  return checkedSlice<CalendarEventsSlice>(
    ctx,
    SLICE.calendarEvents,
    () => ({}),
    (value) => isRow(value) && Object.values(value).every(isList),
    (value) =>
      isRow(value)
        ? (Object.fromEntries(Object.entries(value).map(([id, rows]) => [id, Array.isArray(rows) ? rows.filter(isEventRow) : []])) as CalendarEventsSlice)
        : {},
  );
}

/** A failing sync subject (an account's calendar list, or one calendar) and how long it waits. */
export interface SyncFailureState {
  /** Scheduled syncs skip the subject until then (0: no backoff, the next interval tries again). */
  retryAt: number;
  /** Consecutive failures with {@link signature}. */
  failures: number;
  /** Code and message of the failure: the same one again is a repeat. */
  signature: string;
}

/** When an account's calendars were last synced (tried), and what is failing. */
export interface CalendarSyncState {
  /** Last sync attempt (success or failure), epoch ms. */
  attemptedAt: number;
  /** The calendar list failed, or the provider rate-limited the account; null after a good listing. */
  failure: SyncFailureState | null;
  /** Calendars whose last listing failed, by calendar id. */
  calendars: Record<string, SyncFailureState>;
}

export type CalendarSyncSlice = Record<string, CalendarSyncState>;

function isFailureState(value: unknown): boolean {
  return isRow(value) && Number.isFinite(value.retryAt) && Number.isFinite(value.failures) && typeof value.signature === 'string';
}

function isSyncState(value: unknown): boolean {
  return (
    isRow(value) &&
    Number.isFinite(value.attemptedAt) &&
    (value.failure === null || isFailureState(value.failure)) &&
    isRow(value.calendars) &&
    Object.values(value.calendars).every(isFailureState)
  );
}

export function getCalendarSync(ctx: StaticContext): CalendarSyncSlice {
  return checkedSlice<CalendarSyncSlice>(
    ctx,
    SLICE.calendarSync,
    () => ({}),
    (value) => isRow(value) && Object.values(value).every(isSyncState),
    (value) => (isRow(value) ? (Object.fromEntries(Object.entries(value).filter(([, v]) => isSyncState(v))) as CalendarSyncSlice) : {}),
  );
}
