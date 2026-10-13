/**
 * The IMAP protocol work of one short-lived session (§8 Generic IMAP, §4.10), written so it can
 * run inside a `worker_threads` worker (see imap-runner.ts / imap-worker.ts): imapflow parses every
 * server response synchronously, and a hostile server (or, before STARTTLS, anyone on the path)
 * can make that parse super-linear. Running the session off the main thread keeps the API, the
 * new-tab page and the scheduler responsive whatever the server sends.
 *
 * This module therefore imports nothing heavy (no zod/@portly/shared values, no Hono): jobs and
 * their outputs are plain structured-cloneable data, and failures are either {@link ImapOpError}
 * (a decision this code made, e.g. `stale_message`), {@link ImapAuthError} (rejected login) or a
 * raw imapflow error whose few relevant fields are carried across by {@link serializeImapError}.
 * Mapping to `HttpError`s and `MailMessage`s happens on the main thread (imap.ts).
 *
 * Progress (§17): the session reports each {@link ImapPhase} it enters through `onPhase` (the
 * worker posts them to the parent), so a failure or a timeout — even one that ends with the worker
 * terminated — names the step it happened in. The sub-steps of `connect()` (TCP/TLS connect,
 * greeting, STARTTLS, login) are read from the client's public state ({@link connectPhase}).
 */
import type { ImapSecurity } from '@portly/shared';
import type { ImapMessageRef } from './imap-id.ts';
import type { MailAction } from './types.ts';

// ---------------------------------------------------------------------------
// The subset of the imapflow client this module uses (tests substitute a fake).
// ---------------------------------------------------------------------------

export interface ImapListEntry {
  path: string;
  name: string;
  parentPath?: string;
  flags: Set<string>;
  specialUse?: string | undefined;
  specialUseSource?: string | undefined;
}

export interface ImapAddress {
  name?: string | undefined;
  address?: string | undefined;
}

export interface ImapFetched {
  uid: number;
  flags?: Set<string> | undefined;
  envelope?:
    | {
        date?: Date | string | undefined;
        subject?: string | undefined;
        from?: ImapAddress[] | undefined;
        sender?: ImapAddress[] | undefined;
      }
    | undefined;
  internalDate?: Date | string | undefined;
}

export interface ImapMailboxInfo {
  path: string;
  uidValidity: bigint;
  exists: number;
  readOnly?: boolean | undefined;
}

export interface ImapFetchQuery {
  uid: true;
  flags: true;
  envelope: true;
  internalDate: true;
}

export interface ImapSearchQuery {
  seen?: boolean;
  uid?: string;
  /** Sequence-number range the search is restricted to (e.g. `'1001:2000'`). */
  seq?: string;
}

export interface ImapClientLike {
  readonly capabilities: ReadonlyMap<string, boolean | number>;
  /** Extensions turned on with ENABLE (imapflow ENABLEs IMAP4rev2 when offered). */
  readonly enabled?: ReadonlySet<string>;
  readonly mailbox: ImapMailboxInfo | false;
  // Connection progress (imapflow's public state; read by connectPhase, never logged):
  /** Set once the TCP/TLS connection is up (`false` for cleartext); undefined before. */
  readonly tls?: object | false | undefined;
  /** Set once the server greeted. */
  readonly greeting?: string | undefined;
  /** True for implicit TLS from the start, and after a successful STARTTLS. */
  readonly secureConnection?: boolean | undefined;
  /** Truthy once logged in. */
  readonly authenticated?: string | boolean | undefined;
  on(event: 'error', listener: (err: Error) => void): unknown;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(): Promise<ImapListEntry[]>;
  status(path: string, query: { unseen?: boolean }): Promise<{ unseen?: number | undefined }>;
  getMailboxLock(path: string, options?: { readOnly?: boolean; acquireTimeout?: number }): Promise<{ release(): void }>;
  search(query: ImapSearchQuery, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchAll(range: string, query: ImapFetchQuery, options?: { uid?: boolean }): Promise<ImapFetched[]>;
  messageFlagsAdd(range: string, flags: string[], options: { uid: true }): Promise<boolean>;
  messageFlagsRemove(range: string, flags: string[], options: { uid: true }): Promise<boolean>;
  messageMove(range: string, destination: string, options: { uid: true }): Promise<object | false | undefined>;
  messageCopy(range: string, destination: string, options: { uid: true }): Promise<object | false | undefined>;
  messageDelete(range: string, options: { uid: true }): Promise<boolean | undefined>;
}

export interface ImapConnectionParams {
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  password: string;
}

export type ImapClientFactory = (params: ImapConnectionParams) => ImapClientLike;

// ---------------------------------------------------------------------------
// Special-use folders
// ---------------------------------------------------------------------------

export const TRASH_FALLBACK_NAMES = ['Trash', 'Deleted Items', 'Deleted Messages', 'Bin'] as const;
export const ARCHIVE_FALLBACK_NAMES = ['Archive'] as const;

export interface ImapFolders {
  trash: string | null;
  archive: string | null;
}

function selectable(entry: ImapListEntry): boolean {
  return !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent') && entry.path.toUpperCase() !== 'INBOX';
}

function bySpecialUse(entries: readonly ImapListEntry[], use: '\\Trash' | '\\Archive'): string | null {
  // Server-reported attributes only (SPECIAL-USE / XLIST), never imapflow's localized name guesses.
  const match = entries.find(
    (e) => selectable(e) && (e.flags.has(use) || (e.specialUse === use && e.specialUseSource !== undefined && e.specialUseSource !== 'name')),
  );
  return match?.path ?? null;
}

function byName(entries: readonly ImapListEntry[], names: readonly string[]): string | null {
  for (const name of names) {
    const match =
      entries.find((e) => selectable(e) && e.path === name) ??
      // Namespace-prefixed servers (Courier/Cyrus): "INBOX.Trash".
      entries.find((e) => selectable(e) && e.name === name && (e.parentPath ?? '').toUpperCase() === 'INBOX');
    if (match) return match.path;
  }
  return null;
}

/** Trash / Archive targets from a LIST response (§4.10). */
export function resolveFolders(entries: readonly ImapListEntry[]): ImapFolders {
  return {
    trash: bySpecialUse(entries, '\\Trash') ?? byName(entries, TRASH_FALLBACK_NAMES),
    archive: bySpecialUse(entries, '\\Archive') ?? byName(entries, ARCHIVE_FALLBACK_NAMES),
  };
}

export type MoveStrategy = 'move' | 'copy-expunge';

/** Extensions RFC 9051 folds into base IMAP4rev2 that this module relies on. */
const REV2_FOLDED = new Set(['MOVE', 'UIDPLUS']);

/**
 * Capability check mirroring imapflow's own `hasCapability` (advertised, or folded into an
 * active IMAP4rev2 session). It must never be *more* permissive than imapflow's, because imapflow
 * decides between `UID MOVE` and its unsafe COPY+EXPUNGE emulation, and between `UID EXPUNGE`
 * and a plain `EXPUNGE`, with that check.
 */
function hasCapability(capabilities: ReadonlyMap<string, boolean | number>, enabled: ReadonlySet<string>, name: string): boolean {
  if (capabilities.has(name)) return true;
  if (!REV2_FOLDED.has(name)) return false;
  return enabled.has('IMAP4REV2') || (capabilities.has('IMAP4rev2') && !capabilities.has('IMAP4rev1'));
}

/** `UID MOVE` when MOVE is available; COPY + STORE + UID EXPUNGE only with UIDPLUS; else null. */
export function moveStrategy(
  capabilities: ReadonlyMap<string, boolean | number>,
  enabled: ReadonlySet<string> = new Set<string>(),
): MoveStrategy | null {
  if (hasCapability(capabilities, enabled, 'MOVE')) return 'move';
  if (hasCapability(capabilities, enabled, 'UIDPLUS')) return 'copy-expunge';
  return null;
}

function clientMoveStrategy(client: ImapClientLike): MoveStrategy | null {
  return moveStrategy(client.capabilities, client.enabled);
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** Steps of one session, in the order a listing or an action goes through them. */
export const IMAP_PHASES = [
  'connect',
  'greeting',
  'starttls',
  'login',
  'list',
  'status',
  'examine',
  'select',
  'search',
  'fetch',
  'store',
  'move',
  'copy',
  'expunge',
  'logout',
] as const;
export type ImapPhase = (typeof IMAP_PHASES)[number];
export type ImapProgress = (phase: ImapPhase) => void;

const PHASE_SET: ReadonlySet<string> = new Set(IMAP_PHASES);

export function isImapPhase(value: unknown): value is ImapPhase {
  return typeof value === 'string' && PHASE_SET.has(value);
}

/** The steps inside imapflow's `connect()`, in order. */
const CONNECT_ORDER = { connect: 0, greeting: 1, starttls: 2, login: 3 } as const;
export type ImapConnectPhase = keyof typeof CONNECT_ORDER;

/** How often the connect sub-step is re-read while `connect()` runs (a few property reads). */
export const CONNECT_PHASE_POLL_MS = 25;

/**
 * How far imapflow's `connect()` got: from the error it failed with when that names the step
 * (`authenticationFailed`, `CONNECT_TIMEOUT`, `GREETING_TIMEOUT`, `UPGRADE_TIMEOUT`,
 * `STARTTLS_INJECTION`), else from the client's public state — `tls` is set once the TCP/TLS
 * connection is up, `greeting` once the server greeted, `secureConnection` after STARTTLS; past
 * that the session is logging in (CAPABILITY, ID, LOGIN, NAMESPACE, ENABLE).
 */
export function connectPhase(client: ImapClientLike, security: ImapSecurity, err?: unknown): ImapConnectPhase {
  const e = (err ?? {}) as { code?: unknown; authenticationFailed?: unknown };
  if (e.authenticationFailed === true) return 'login';
  switch (e.code) {
    case 'CONNECT_TIMEOUT':
      return 'connect';
    case 'GREETING_TIMEOUT':
      return 'greeting';
    case 'UPGRADE_TIMEOUT':
    case 'STARTTLS_INJECTION':
      return 'starttls';
    default:
      break;
  }
  if (client.tls === undefined) return 'connect';
  if (client.greeting === undefined) return 'greeting';
  if (security === 'starttls' && client.secureConnection !== true) return 'starttls';
  return 'login';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for a rejected login (runtime: reauth; probe: bad credentials). */
export class ImapAuthError extends Error {
  override name = 'ImapAuthError';
}

export type ImapOpErrorCode = 'provider_error' | 'validation_failed' | 'conflict' | 'not_found';

/** A refusal decided by this module (mapped 1:1 to an `HttpError` with the account id). */
export class ImapOpError extends Error {
  override name = 'ImapOpError';
  readonly status: number;
  readonly code: ImapOpErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ImapOpErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The fields of an imapflow/socket error that decide how it is reported (never its text). */
export interface ImapErrorFields {
  code?: string | undefined;
  authenticationFailed?: boolean | undefined;
  serverResponseCode?: string | undefined;
  tlsFailed?: boolean | undefined;
}

export type SerializedImapError =
  | { kind: 'auth' }
  | { kind: 'op'; status: number; code: ImapOpErrorCode; message: string; details?: unknown }
  | { kind: 'imap'; fields: ImapErrorFields };

/** Machine tokens only (a response code is chosen by the server and could otherwise carry text). */
const CODE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

function codeField(value: unknown): string | undefined {
  return typeof value === 'string' && CODE_TOKEN.test(value) ? value : undefined;
}

/** The reportable fields of an imapflow/socket error: codes and flags only, never its text. */
export function imapErrorFields(err: unknown): ImapErrorFields {
  const e = (err ?? {}) as Record<string, unknown>;
  const fields: ImapErrorFields = {};
  const code = codeField(e.code);
  if (code !== undefined) fields.code = code;
  if (e.authenticationFailed === true) fields.authenticationFailed = true;
  const responseCode = codeField(e.serverResponseCode);
  if (responseCode !== undefined) fields.serverResponseCode = responseCode;
  if (e.tlsFailed === true) fields.tlsFailed = true;
  return fields;
}

/** Structured-cloneable form of anything a session throws (server text is dropped). */
export function serializeImapError(err: unknown): SerializedImapError {
  if (err instanceof ImapAuthError) return { kind: 'auth' };
  if (err instanceof ImapOpError) {
    const out: SerializedImapError = { kind: 'op', status: err.status, code: err.code, message: err.message };
    if (err.details !== undefined) out.details = err.details;
    return out;
  }
  return { kind: 'imap', fields: imapErrorFields(err) };
}

/** Inverse of {@link serializeImapError}: an error the main-thread mapper understands. */
export function deserializeImapError(value: SerializedImapError): Error {
  if (value.kind === 'auth') return new ImapAuthError('The mail server rejected the username or password');
  if (value.kind === 'op') return new ImapOpError(value.status, value.code, value.message, value.details);
  return Object.assign(new Error('IMAP session failed'), value.fields);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface ImapSessionOptions {
  signal?: AbortSignal | undefined;
  onConnectionError?: ((err: Error) => void) | undefined;
  /** Each phase as the session enters it (the connect sub-steps never go backwards). */
  onPhase?: ImapProgress | undefined;
}

/**
 * connect → fn → logout on one short-lived connection; always closed on failure or abort.
 * Errors are rethrown unmapped (see {@link serializeImapError} / imap.ts `mapImapError`). `fn`
 * gets the reporter for the phases of its own work.
 */
export async function runImapSession<T>(
  connect: ImapClientFactory,
  params: ImapConnectionParams,
  opts: ImapSessionOptions,
  fn: (client: ImapClientLike, report: ImapProgress) => Promise<T>,
): Promise<T> {
  const report: ImapProgress = (phase) => opts.onPhase?.(phase);
  const client = connect(params);
  // imapflow emits 'error' for socket problems; without a listener that would crash the thread.
  client.on('error', (err: Error) => opts.onConnectionError?.(err));
  const onAbort = (): void => client.close();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  // connect() goes through connect → greeting → STARTTLS → login without telling anyone: its state
  // is re-read while it runs and once more from its error (close() resets `authenticated`, so the
  // reported step only moves forward).
  let reached: ImapConnectPhase = 'connect';
  const advance = (phase: ImapConnectPhase): void => {
    if (CONNECT_ORDER[phase] <= CONNECT_ORDER[reached]) return;
    reached = phase;
    report(phase);
  };
  report('connect');
  const watch = setInterval(() => advance(connectPhase(client, params.security)), CONNECT_PHASE_POLL_MS);
  watch.unref();
  try {
    try {
      await client.connect();
    } catch (err) {
      advance(connectPhase(client, params.security, err));
      throw err;
    } finally {
      clearInterval(watch);
    }
    const result = await fn(client, report);
    report('logout');
    // Polite LOGOUT without holding up the response (bounded by the socket timeout; close on failure).
    void client.logout().catch(() => client.close());
    return result;
  } catch (err) {
    client.close();
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * `unreadOnly` searches only the newest this-many messages (by sequence number): a plain
 * `UID SEARCH UNSEEN` returns every unseen UID of the mailbox on one line, which for a big unread
 * backlog would exceed the (deliberately small) line limit of imap-client.ts. The unread *count*
 * still comes from `STATUS INBOX (UNSEEN)`.
 */
export const UNREAD_SCAN_WINDOW = 1000;

export const IMAP_FETCH_QUERY: ImapFetchQuery = Object.freeze({ uid: true, flags: true, envelope: true, internalDate: true });

export type ImapJob =
  | { op: 'list'; maxMessages: number; unreadOnly: boolean; folders: ImapFolders | null }
  | { op: 'act'; ref: ImapMessageRef; action: MailAction; folders: ImapFolders | null }
  | { op: 'probe' };

export interface ImapListOutput {
  op: 'list';
  folders: ImapFolders;
  /** `STATUS INBOX (UNSEEN)`, when the server reported a number. */
  unseen: number | null;
  mailbox: { path: string; uidValidity: bigint };
  /** At most `maxMessages` + a few (the main thread filters, sorts and maps). */
  fetched: ImapFetched[];
  movable: boolean;
}

export interface ImapActOutput {
  op: 'act';
  /** Resolved special-use folders when the action needed them. */
  folders: ImapFolders | null;
}

export interface ImapProbeOutput {
  op: 'probe';
}

export type ImapJobOutput = ImapListOutput | ImapActOutput | ImapProbeOutput;

/** Only the fields the mapper reads, so a worker never ships whole envelopes back. */
function trimFetched(f: ImapFetched): ImapFetched {
  const out: ImapFetched = { uid: f.uid };
  if (f.flags instanceof Set) out.flags = new Set([...f.flags].filter((flag) => typeof flag === 'string').slice(0, 32));
  if (f.internalDate !== undefined) out.internalDate = f.internalDate;
  const env = f.envelope;
  if (env) {
    const pick = (list: ImapAddress[] | undefined): ImapAddress[] | undefined =>
      Array.isArray(list) && list[0] ? [{ name: list[0].name, address: list[0].address }] : undefined;
    out.envelope = { date: env.date, subject: env.subject, from: pick(env.from), sender: pick(env.sender) };
  }
  return out;
}

async function resolveFoldersOf(client: ImapClientLike, cached: ImapFolders | null, report: ImapProgress): Promise<ImapFolders> {
  if (cached) return cached;
  report('list');
  return resolveFolders(await client.list());
}

async function listJob(client: ImapClientLike, job: Extract<ImapJob, { op: 'list' }>, report: ImapProgress): Promise<ImapListOutput> {
  const folders = await resolveFoldersOf(client, job.folders, report);
  // STATUS before selecting: RFC 3501 discourages STATUS on the selected mailbox.
  report('status');
  const status = await client.status('INBOX', { unseen: true });
  report('examine');
  const lock = await client.getMailboxLock('INBOX', { readOnly: true, acquireTimeout: 15_000 });
  try {
    const mailbox = client.mailbox;
    if (!mailbox) throw new ImapOpError(502, 'provider_error', 'The inbox could not be opened');
    let fetched: ImapFetched[] = [];
    if (job.unreadOnly) {
      if (mailbox.exists > 0) {
        const first = Math.max(1, mailbox.exists - UNREAD_SCAN_WINDOW + 1);
        report('search');
        const uids = (await client.search({ seq: `${first}:${mailbox.exists}`, seen: false }, { uid: true })) || [];
        const newest = [...uids].sort((a, b) => b - a).slice(0, job.maxMessages);
        if (newest.length > 0) {
          report('fetch');
          fetched = await client.fetchAll(newest.join(','), IMAP_FETCH_QUERY, { uid: true });
        }
      }
    } else if (mailbox.exists > 0) {
      const first = Math.max(1, mailbox.exists - job.maxMessages + 1);
      report('fetch');
      fetched = await client.fetchAll(`${first}:${mailbox.exists}`, IMAP_FETCH_QUERY);
    }
    return {
      op: 'list',
      folders,
      unseen: typeof status.unseen === 'number' ? status.unseen : null,
      mailbox: { path: mailbox.path, uidValidity: mailbox.uidValidity },
      fetched: [...fetched]
        .sort((a, b) => Number(b.uid) - Number(a.uid))
        .slice(0, Math.max(job.maxMessages * 2, 1))
        .map(trimFetched),
      movable: clientMoveStrategy(client) !== null,
    };
  } finally {
    lock.release();
  }
}

async function actJob(client: ImapClientLike, job: Extract<ImapJob, { op: 'act' }>, report: ImapProgress): Promise<ImapActOutput> {
  const { ref, action } = job;
  let target: string | null = null;
  let strategy: MoveStrategy | null = null;
  let folders: ImapFolders | null = null;
  if (action.type !== 'read') {
    folders = await resolveFoldersOf(client, job.folders, report);
    target = action.type === 'trash' ? folders.trash : folders.archive;
    const what = action.type === 'trash' ? 'Trash' : 'Archive';
    if (target === null) throw new ImapOpError(422, 'validation_failed', `This mailbox has no ${what} folder`);
    if (target === ref.mailbox) throw new ImapOpError(422, 'validation_failed', `The message is already in ${what}`);
    strategy = clientMoveStrategy(client);
    if (strategy === null) {
      throw new ImapOpError(422, 'validation_failed', 'The mail server does not support moving messages safely (no MOVE or UIDPLUS)');
    }
  }

  report('select');
  const lock = await client.getMailboxLock(ref.mailbox, { acquireTimeout: 15_000 });
  try {
    const mailbox = client.mailbox;
    if (!mailbox || mailbox.readOnly) throw new ImapOpError(502, 'provider_error', 'The mailbox could not be opened for changes');
    if (String(mailbox.uidValidity) !== ref.uidValidity) {
      throw new ImapOpError(409, 'conflict', 'The mailbox changed since it was listed; refresh and try again', { reason: 'stale_message' });
    }
    const uid = String(ref.uid);
    report('search');
    const found = await client.search({ uid }, { uid: true });
    if (!found || !found.includes(ref.uid)) throw new ImapOpError(404, 'not_found', 'The message no longer exists; refresh the list');
    const failed = (message: string) => new ImapOpError(502, 'provider_error', message);

    if (action.type === 'read') {
      report('store');
      const ok = action.read
        ? await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
        : await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
      if (!ok) throw failed('The mail server did not update the message');
      return { op: 'act', folders };
    }

    if (strategy === 'move') {
      report('move');
      const moved = await client.messageMove(uid, target as string, { uid: true });
      if (!moved) throw failed('The mail server did not move the message');
      return { op: 'act', folders };
    }
    // copy-expunge (UIDPLUS advertised): delete from the inbox only after a successful copy.
    report('copy');
    const copied = await client.messageCopy(uid, target as string, { uid: true });
    if (!copied) throw failed('The mail server did not copy the message; nothing was removed');
    // STORE +FLAGS (\Deleted) then UID EXPUNGE <uid> (UIDPLUS) — only this message is expunged.
    report('expunge');
    const removed = await client.messageDelete(uid, { uid: true });
    if (!removed) throw failed('The message was copied but could not be removed from the inbox');
    return { op: 'act', folders };
  } finally {
    lock.release();
  }
}

/** Runs one job on a connected client, reporting each phase it enters. */
export async function runImapJob(client: ImapClientLike, job: ImapJob, report: ImapProgress = () => {}): Promise<ImapJobOutput> {
  switch (job.op) {
    case 'list':
      return listJob(client, job, report);
    case 'act':
      return actJob(client, job, report);
    case 'probe':
      report('status');
      await client.status('INBOX', { unseen: true });
      return { op: 'probe' };
  }
}
