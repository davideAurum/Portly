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
 * the calendar cache are never exported (and an import never touches them), and neither is the
 * list of one-time data upgrades already applied.
 */
import {
  ACCOUNT_STATUSES,
  CALENDAR_SOURCES,
  CAPABILITIES,
  SETTINGS_NAMESPACES,
  SettingsSchema,
  SyncIconSchema,
  SyncPointersSchema,
  defaultSettings,
  settingsNamespaceSchema,
  type AccountStatus,
  type Capability,
  type Profile,
  type Settings,
  type SyncIcon,
  type SyncPointers,
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
  upgrades: 'upgrades',
  launchpadSync: 'launchpad-sync',
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

/**
 * Names of the one-time data upgrades already applied in this browser (the static counterpart of
 * the server's `schema_migrations`), so an upgrade never runs twice. Never exported.
 */
export function getUpgrades(ctx: StaticContext): string[] {
  return rowsSlice<string>(ctx, SLICE.upgrades, (name) => typeof name === 'string');
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

/*
 * Launch pad sync (docs/design/launchpad-sync.md section 6) needs two stamps per row and lasting
 * tombstones. Stamps come from the launch pad clock (sync/clock.ts), never `ctx.now()` directly:
 * `updatedAt` stamps the content (name, color, collapsed; title, URL, icon, letter color),
 * `placedAt` the placement (`sort`, and `groupId` for a bookmark), so reordering on one PC never
 * undoes a rename made on another.
 */

export interface StoredBookmarkGroup {
  id: string;
  name: string;
  sort: number;
  color: string | null;
  collapsed: boolean;
  createdAt: number;
  /** Content stamp: name, color, collapsed. */
  updatedAt: number;
  /** Placement stamp: sort. */
  placedAt: number;
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
  /** Content stamp: title, URL, icon, letter color. */
  updatedAt: number;
  /** Placement stamp: sort and groupId. */
  placedAt: number;
}

export const TOMBSTONE_KINDS = ['group', 'bookmark'] as const;
export type TombstoneKind = (typeof TOMBSTONE_KINDS)[number];

/** A removed row, written in the same commit as the removal so a merge cannot bring it back. */
export interface Tombstone {
  kind: TombstoneKind;
  id: string;
  /** Launch pad clock stamp of the removal. */
  at: number;
}

export interface BookmarksSlice {
  groups: StoredBookmarkGroup[];
  bookmarks: StoredBookmark[];
  /** Tombstones, added by sync/tombstones.ts and kept {@link TOMBSTONE_TTL_MS}. Never exported. */
  deleted: Tombstone[];
}

/** How long a tombstone is kept (design section 6.3). */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function isTombstone(value: unknown): value is Tombstone {
  return isRow(value) && (TOMBSTONE_KINDS as readonly unknown[]).includes(value.kind) && typeof value.id === 'string' && Number.isFinite(value.at);
}

/** Bookmarks slices whose rows already have their sync fields (identity changes when replaced). */
const syncReadySlices = new WeakSet<object>();

/**
 * Rows stored before the sync fields existed (or written meanwhile by an older build in another
 * tab) get `placedAt = updatedAt`, and the slice an empty tombstone list. In memory only; the
 * `bookmarks-sync-fields` upgrade (handlers/bookmarks.ts) persists it once.
 */
function withSyncFields(slice: BookmarksSlice): BookmarksSlice {
  if (syncReadySlices.has(slice)) return slice;
  for (const row of [...slice.groups, ...slice.bookmarks]) {
    if (!Number.isFinite(row.updatedAt)) row.updatedAt = Number.isFinite(row.createdAt) ? row.createdAt : 0;
    if (!Number.isFinite(row.placedAt)) row.placedAt = row.updatedAt;
  }
  if (!Array.isArray(slice.deleted)) slice.deleted = [];
  syncReadySlices.add(slice);
  return slice;
}

export function getBookmarks(ctx: StaticContext): BookmarksSlice {
  const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value.filter(hasId) : []);
  const tombstones = (value: unknown): Tombstone[] => (Array.isArray(value) ? value.filter(isTombstone) : []);
  const slice = checkedSlice<BookmarksSlice>(
    ctx,
    SLICE.bookmarks,
    () => ({ groups: [], bookmarks: [], deleted: [] }),
    (value) =>
      isRow(value) &&
      Array.isArray(value.groups) &&
      value.groups.every(hasId) &&
      Array.isArray(value.bookmarks) &&
      value.bookmarks.every(hasId) &&
      (value.deleted === undefined || (Array.isArray(value.deleted) && value.deleted.every(isTombstone))),
    (value) => ({
      groups: rows(isRow(value) ? value.groups : undefined) as StoredBookmarkGroup[],
      bookmarks: rows(isRow(value) ? value.bookmarks : undefined) as StoredBookmark[],
      deleted: tombstones(isRow(value) ? value.deleted : undefined),
    }),
  );
  return withSyncFields(slice);
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
export const BACKUP_REASONS = ['import', 'sync'] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

export interface BackupEntry {
  id: string;
  /** When the import (or a sync) replaced the data (epoch ms). */
  at: number;
  /** Length of the stored export document (characters), for the UI. */
  bytes: number;
  /** What it was taken before (absent on entries from before sync existed: an import). */
  reason?: BackupReason;
}

export interface BackupsSlice {
  entries: BackupEntry[];
}

/** Import backups kept. Sync keeps {@link MAX_SYNC_BACKUPS} of its own besides (ROADMAP D8). */
export const MAX_BACKUPS = 3;
export const MAX_SYNC_BACKUPS = 1;

/**
 * Splits backup entries into those kept (newest first: the newest {@link MAX_BACKUPS} import
 * backups and the newest {@link MAX_SYNC_BACKUPS} sync backups, so a sync never pushes out an
 * import's backup or the other way round) and those to delete.
 */
export function keepBackups(entries: readonly BackupEntry[]): { kept: BackupEntry[]; evicted: BackupEntry[] } {
  const kept: BackupEntry[] = [];
  const evicted: BackupEntry[] = [];
  let imports = 0;
  let syncs = 0;
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const sync = entry.reason === 'sync';
    if (sync ? syncs < MAX_SYNC_BACKUPS : imports < MAX_BACKUPS) {
      kept.push(entry);
      if (sync) syncs++;
      else imports++;
    } else evicted.push(entry);
  }
  return { kept, evicted };
}

export const BACKUP_KEY_PREFIX = 'backup:';

/** Storage key of a backup's export document. */
export function backupKey(id: string): string {
  return `${BACKUP_KEY_PREFIX}${id}`;
}

function isBackupEntry(entry: unknown): boolean {
  return (
    hasId(entry) &&
    Number.isFinite(entry.at) &&
    Number.isFinite(entry.bytes) &&
    (entry.reason === undefined || (BACKUP_REASONS as readonly unknown[]).includes(entry.reason))
  );
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
  /** The services this browser may use: asked for by the last sign-in and in its grant. */
  capabilities: Capability[];
  enabledCapabilities: Capability[];
  /** What Microsoft reported as granted (normalized): every grant of the account, not only this sign-in's. */
  grantedScopes: string[];
  /**
   * The scopes the last sign-in asked for (normalized). Refreshes and automatic re-sign-ins never
   * ask for more. Absent on rows stored before it was recorded, until the `account-requested-scopes`
   * upgrade fills it (handlers/accounts.ts).
   */
  requestedScopes?: string[];
  status: AccountStatus;
  statusMessage: string | null;
  sort: number;
  createdAt: number;
  updatedAt: number;
}

function isCapabilityList(value: unknown): boolean {
  return Array.isArray(value) && value.every((c) => (CAPABILITIES as readonly unknown[]).includes(c));
}

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((s) => typeof s === 'string');
}

function isAccountRow(row: unknown): boolean {
  return (
    hasId(row) &&
    row.kind === 'microsoft' &&
    typeof row.label === 'string' &&
    typeof row.externalId === 'string' &&
    isCapabilityList(row.capabilities) &&
    isCapabilityList(row.enabledCapabilities) &&
    (row.requestedScopes === undefined || isStringList(row.requestedScopes)) &&
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
  /** The services the sign-in asked for (absent on a sign-in started before they were recorded: all). */
  capabilities?: Capability[];
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
    (row.capabilities === undefined || isCapabilityList(row.capabilities)) &&
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

// ---------------------------------------------------------------------------
// Launch pad sync state (this browser only; never exported)
// ---------------------------------------------------------------------------

/** Where launch pad sync stands in this browser, for the Accounts page (6.6) and Diagnostics. */
export const LAUNCHPAD_SYNC_STATUSES = [
  /** Never synced, or the service is off. */
  'off',
  'up_to_date',
  /** Both this browser and the synced file have a launch pad: the user picks (design 6.6). */
  'needs_choice',
  /** The account needs reconnecting. */
  'paused_reauth',
  /** The synced file was written by a newer Portly. */
  'stopped_newer',
  /** The synced file could not be read (`problem` says why). */
  'refused',
  /** Other browsers kept writing: three rounds in a row lost the race. */
  'busy',
  'error',
] as const;
export type LaunchpadSyncStatus = (typeof LAUNCHPAD_SYNC_STATUSES)[number];

export interface RehomedBookmark {
  groupId: string;
  placedAt: number;
}

/** The values of the synced settings this browser last applied or recorded. */
export interface AppliedPointers {
  defaultGroupId: string | null;
  ungroupedGroupId: string | null;
}

/**
 * Launch pad sync's own state (docs/design/launchpad-sync.md section 2), this browser only.
 * Never holds a token, a URL or file content beyond the icon list.
 */
export interface LaunchpadSyncSlice {
  /** The launch pad clock: the highest stamp this browser has given out or seen (sync/clock.ts). */
  clock: number;
  /** Local changes not uploaded yet (set by the commit hook, cleared by a successful upload). */
  waiting: boolean;
  /** Counts local changes (the commit hook): a sync clears `waiting` only if none came in meanwhile. */
  changes: number;
  /** The synced settings that name a group, each with the stamp of its last change. */
  pointers: SyncPointers;
  /** Their values as this browser last applied or recorded them: a different value in settings is a local change. */
  applied: AppliedPointers;
  /** The Microsoft connection synced with (another one means a first sync). */
  accountId: string | null;
  /** The file generation last merged (null: never synced with this account). */
  epoch: string | null;
  /** The store's version of the file last merged or written (OneDrive: its eTag). */
  version: string | null;
  /** The highest stamp of the file last merged (0: never): rows changed after it were made here since. */
  lastSynced: number;
  /** Wall-clock times: last successful sync, last check (any tab; checks are throttled on it). */
  syncedAt: number | null;
  checkedAt: number | null;
  /** When a change last came in from the file, and last went out to it. */
  receivedAt: number | null;
  sentAt: number | null;
  /** The icon entries of the file last merged (their checksums). */
  icons: SyncIcon[];
  /**
   * Bookmarks this browser shows under "No group" because their group is gone: id → their synced
   * group and the placement stamp they had then (placed again here since: no longer a repair).
   */
  rehomed: Record<string, RehomedBookmark>;
  /** The version of the file last refused (a newer or unreadable one): not read again until it changes. */
  refused: string | null;
  /** Icon files the file stopped naming, deleted from the store 30 days after. */
  droppedIcons: { id: string; at: number }[];
  /** Backoff after failures (0: none). */
  retryAt: number;
  failures: number;
  status: LaunchpadSyncStatus;
  /** A problem code for `refused` or `error` (never content). */
  problem: string | null;
}

function emptyPointers(): SyncPointers {
  return { defaultGroupId: { value: null, at: 0 }, ungroupedGroupId: { value: null, at: 0 } };
}

export function defaultLaunchpadSync(): LaunchpadSyncSlice {
  return {
    clock: 0,
    waiting: false,
    changes: 0,
    pointers: emptyPointers(),
    applied: { defaultGroupId: null, ungroupedGroupId: null },
    accountId: null,
    epoch: null,
    version: null,
    lastSynced: 0,
    syncedAt: null,
    checkedAt: null,
    receivedAt: null,
    sentAt: null,
    icons: [],
    rehomed: {},
    refused: null,
    droppedIcons: [],
    retryAt: 0,
    failures: 0,
    status: 'off',
    problem: null,
  };
}

/** Each field checked on its own: a bad one falls back to its default (a lost clock restarts from the stored rows). */
function repairLaunchpadSync(value: unknown): LaunchpadSyncSlice {
  const raw = isRow(value) ? value : {};
  const base = defaultLaunchpadSync();
  const finite = (v: unknown, fallback: number): number => (Number.isFinite(v) ? Number(v) : fallback);
  const nullableFinite = (v: unknown): number | null => (Number.isFinite(v) ? Number(v) : null);
  const nullableString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const applied = isRow(raw.applied) ? raw.applied : {};
  const pointers = SyncPointersSchema.safeParse(raw.pointers);
  return {
    clock: finite(raw.clock, base.clock),
    waiting: raw.waiting === true,
    changes: finite(raw.changes, 0),
    pointers: pointers.success ? pointers.data : base.pointers,
    applied: { defaultGroupId: nullableString(applied.defaultGroupId), ungroupedGroupId: nullableString(applied.ungroupedGroupId) },
    accountId: nullableString(raw.accountId),
    epoch: nullableString(raw.epoch),
    version: nullableString(raw.version),
    lastSynced: finite(raw.lastSynced, 0),
    syncedAt: nullableFinite(raw.syncedAt),
    checkedAt: nullableFinite(raw.checkedAt),
    receivedAt: nullableFinite(raw.receivedAt),
    sentAt: nullableFinite(raw.sentAt),
    icons: Array.isArray(raw.icons) ? raw.icons.flatMap((icon) => SyncIconSchema.safeParse(icon).data ?? []) : [],
    rehomed: isRow(raw.rehomed)
      ? Object.fromEntries(
          Object.entries(raw.rehomed).flatMap(([id, r]) =>
            isRow(r) && typeof r.groupId === 'string' && Number.isFinite(r.placedAt) ? [[id, { groupId: r.groupId, placedAt: Number(r.placedAt) }]] : [],
          ),
        )
      : {},
    refused: nullableString(raw.refused),
    droppedIcons: Array.isArray(raw.droppedIcons)
      ? raw.droppedIcons.filter((d): d is { id: string; at: number } => isRow(d) && typeof d.id === 'string' && Number.isFinite(d.at))
      : [],
    retryAt: finite(raw.retryAt, 0),
    failures: finite(raw.failures, 0),
    status: (LAUNCHPAD_SYNC_STATUSES as readonly unknown[]).includes(raw.status) ? (raw.status as LaunchpadSyncStatus) : 'off',
    problem: nullableString(raw.problem),
  };
}

function isLaunchpadSyncState(value: unknown): boolean {
  return isRow(value) && JSON.stringify(repairLaunchpadSync(value)) === JSON.stringify(value);
}

export function getLaunchpadSync(ctx: StaticContext): LaunchpadSyncSlice {
  return checkedSlice<LaunchpadSyncSlice>(ctx, SLICE.launchpadSync, defaultLaunchpadSync, isLaunchpadSyncState, repairLaunchpadSync);
}
