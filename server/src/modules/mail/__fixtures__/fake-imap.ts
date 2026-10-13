/**
 * A scripted in-memory IMAP server + client implementing the `ImapClientLike` subset of imapflow.
 * Every command a client issues is appended to `server.log` in IMAP-ish notation
 * (`UID MOVE 7 Trash`, `UID EXPUNGE 7`, `EXPUNGE`, …) so tests can assert exactly what would
 * have gone over the wire. `messageDelete` mirrors imapflow: `UID EXPUNGE` only when UIDPLUS is
 * advertised, a plain `EXPUNGE` otherwise (which the module must never trigger).
 */
import type {
  ImapClientFactory,
  ImapClientLike,
  ImapConnectionParams,
  ImapFetched,
  ImapFetchQuery,
  ImapListEntry,
  ImapMailboxInfo,
} from '../providers/imap.ts';

export interface FakeMessage {
  uid: number;
  flags: Set<string>;
  subject?: string;
  from?: { name?: string; address?: string }[];
  date?: string;
  internalDate?: string;
}

export interface FakeMailbox {
  path: string;
  uidValidity: bigint;
  messages: FakeMessage[];
}

export interface FakeImapServerOptions {
  capabilities?: string[];
  list?: ImapListEntry[];
  mailboxes?: FakeMailbox[];
  password?: string;
}

export function listEntry(path: string, extra: Omit<Partial<ImapListEntry>, 'flags'> & { flags?: string[] } = {}): ImapListEntry {
  const delimiter = path.includes('.') ? '.' : '/';
  const idx = path.lastIndexOf(delimiter);
  const { flags, ...rest } = extra;
  return {
    path,
    name: idx >= 0 ? path.slice(idx + 1) : path,
    parentPath: idx >= 0 ? path.slice(0, idx) : '',
    flags: new Set(flags ?? []),
    ...rest,
  };
}

export function message(uid: number, opts: { seen?: boolean; subject?: string; from?: string; name?: string; date?: string } = {}): FakeMessage {
  return {
    uid,
    flags: new Set(opts.seen ? ['\\Seen'] : []),
    subject: opts.subject ?? `Message ${uid}`,
    from: [{ name: opts.name ?? `Sender ${uid}`, address: opts.from ?? `sender${uid}@example.com` }],
    date: opts.date ?? new Date(Date.UTC(2026, 8, 1, 8, uid)).toUTCString(),
    internalDate: opts.date ?? new Date(Date.UTC(2026, 8, 1, 8, uid)).toISOString(),
  };
}

export class FakeImapServer {
  capabilities: Set<string>;
  list: ImapListEntry[];
  mailboxes: Map<string, FakeMailbox>;
  password: string;
  readonly log: string[] = [];
  readonly clients: FakeImapClient[] = [];
  /** Params of every connection attempt. */
  readonly connections: ImapConnectionParams[] = [];
  /** Next connect() rejects with this error. */
  connectError: (Error & Record<string, unknown>) | null = null;
  /** connect() never settles (until the client is closed). */
  hang = false;
  failCopy = false;
  failMove = false;
  failStore = false;

  constructor(options: FakeImapServerOptions = {}) {
    this.capabilities = new Set(options.capabilities ?? ['IMAP4rev1', 'MOVE', 'UIDPLUS', 'SPECIAL-USE']);
    this.list = options.list ?? [
      listEntry('INBOX', { specialUse: '\\Inbox' }),
      listEntry('Trash', { flags: ['\\HasNoChildren', '\\Trash'], specialUse: '\\Trash', specialUseSource: 'extension' }),
      listEntry('Archive', { flags: ['\\HasNoChildren', '\\Archive'], specialUse: '\\Archive', specialUseSource: 'extension' }),
    ];
    this.password = options.password ?? 'app-password';
    this.mailboxes = new Map();
    for (const box of options.mailboxes ?? [{ path: 'INBOX', uidValidity: 1700000000n, messages: [] }]) this.mailboxes.set(box.path, box);
    for (const entry of this.list) {
      if (!this.mailboxes.has(entry.path)) this.mailboxes.set(entry.path, { path: entry.path, uidValidity: 1n, messages: [] });
    }
  }

  inbox(): FakeMailbox {
    return this.mailboxes.get('INBOX') as FakeMailbox;
  }

  factory(): ImapClientFactory {
    return (params) => {
      this.connections.push(params);
      const client = new FakeImapClient(this, params);
      this.clients.push(client);
      return client;
    };
  }

  /** Clears the command log (e.g. between a listing and an action). */
  clearLog(): void {
    this.log.length = 0;
  }
}

function authError(): Error & Record<string, unknown> {
  const err = new Error('Invalid credentials (Failure)') as Error & Record<string, unknown>;
  err.authenticationFailed = true;
  err.serverResponseCode = 'AUTHENTICATIONFAILED';
  return err;
}

function parseRange(range: string, box: FakeMailbox, byUid: boolean): FakeMessage[] {
  const sorted = [...box.messages].sort((a, b) => a.uid - b.uid);
  const picked: FakeMessage[] = [];
  for (const part of range.split(',')) {
    const [a, b] = part.split(':');
    const lo = Number(a);
    const hi = b === undefined ? lo : Number(b);
    if (byUid) picked.push(...sorted.filter((m) => m.uid >= lo && m.uid <= hi));
    else picked.push(...sorted.filter((_, i) => i + 1 >= lo && i + 1 <= hi));
  }
  return picked;
}

export class FakeImapClient implements ImapClientLike {
  readonly server: FakeImapServer;
  readonly params: ImapConnectionParams;
  readonly errorListeners: ((err: Error) => void)[] = [];
  mailbox: ImapMailboxInfo | false = false;
  closed = false;
  connected = false;
  #hangReject: ((err: Error) => void) | null = null;

  constructor(server: FakeImapServer, params: ImapConnectionParams) {
    this.server = server;
    this.params = params;
  }

  get capabilities(): ReadonlyMap<string, boolean | number> {
    return new Map([...this.server.capabilities].map((c) => [c, true]));
  }

  #cmd(text: string): void {
    if (this.closed) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
    this.server.log.push(text);
  }

  #selected(): FakeMailbox {
    if (!this.mailbox) throw new Error('No mailbox selected');
    return this.server.mailboxes.get(this.mailbox.path) as FakeMailbox;
  }

  on(event: 'error', listener: (err: Error) => void): this {
    if (event === 'error') this.errorListeners.push(listener);
    return this;
  }

  async connect(): Promise<void> {
    if (this.errorListeners.length === 0) throw new Error('fake-imap: an error listener must be attached before connect()');
    this.#cmd('CONNECT');
    if (this.server.hang) {
      await new Promise<void>((_, reject) => {
        this.#hangReject = reject;
      });
    }
    if (this.server.connectError) throw this.server.connectError;
    if (this.params.password !== this.server.password) throw authError();
    this.connected = true;
  }

  async logout(): Promise<void> {
    this.#cmd('LOGOUT');
    this.closed = true;
  }

  close(): void {
    if (!this.closed) this.server.log.push('CLOSE');
    this.closed = true;
    this.#hangReject?.(Object.assign(new Error('Connection closed'), { code: 'NoConnection' }));
    this.#hangReject = null;
  }

  async list(): Promise<ImapListEntry[]> {
    this.#cmd('LIST');
    return this.server.list;
  }

  async status(path: string, query: { unseen?: boolean }): Promise<{ unseen?: number }> {
    this.#cmd(`STATUS ${path} (${query.unseen ? 'UNSEEN' : ''})`);
    const box = this.server.mailboxes.get(path);
    if (!box) throw Object.assign(new Error('Mailbox does not exist'), { mailboxMissing: true });
    return { unseen: box.messages.filter((m) => !m.flags.has('\\Seen')).length };
  }

  async getMailboxLock(path: string, options: { readOnly?: boolean } = {}): Promise<{ release(): void }> {
    this.#cmd(`${options.readOnly ? 'EXAMINE' : 'SELECT'} ${path}`);
    const box = this.server.mailboxes.get(path);
    if (!box) throw Object.assign(new Error('Mailbox does not exist'), { mailboxMissing: true });
    this.mailbox = { path, uidValidity: box.uidValidity, exists: box.messages.length, readOnly: options.readOnly === true };
    return { release: () => this.server.log.push(`RELEASE ${path}`) };
  }

  async search(query: { seen?: boolean; uid?: string; seq?: string }, options: { uid: true }): Promise<number[]> {
    const box = this.#selected();
    if (!options.uid) throw new Error('fake-imap: only UID SEARCH is supported');
    if (query.uid !== undefined) {
      this.#cmd(`UID SEARCH UID ${query.uid}`);
      return box.messages.filter((m) => String(m.uid) === query.uid).map((m) => m.uid);
    }
    this.#cmd(`UID SEARCH ${query.seq !== undefined ? `${query.seq} ` : ''}${query.seen === false ? 'UNSEEN' : 'ALL'}`);
    const scope = query.seq !== undefined ? parseRange(query.seq, box, false) : box.messages;
    return scope.filter((m) => (query.seen === false ? !m.flags.has('\\Seen') : true)).map((m) => m.uid);
  }

  async fetchAll(range: string, query: ImapFetchQuery, options: { uid?: boolean } = {}): Promise<ImapFetched[]> {
    const box = this.#selected();
    this.#cmd(`${options.uid ? 'UID FETCH' : 'FETCH'} ${range} (${Object.keys(query).join(' ').toUpperCase()})`);
    return parseRange(range, box, options.uid === true).map((m) => ({
      uid: m.uid,
      flags: new Set(m.flags),
      envelope: { subject: m.subject, from: m.from, date: m.date },
      internalDate: m.internalDate,
    }));
  }

  #store(range: string, flags: string[], op: '+' | '-'): boolean {
    this.#cmd(`UID STORE ${range} ${op}FLAGS (${flags.join(' ')})`);
    if (this.server.failStore) return false;
    for (const m of parseRange(range, this.#selected(), true)) for (const f of flags) op === '+' ? m.flags.add(f) : m.flags.delete(f);
    return true;
  }

  async messageFlagsAdd(range: string, flags: string[], options: { uid: true }): Promise<boolean> {
    if (!options.uid) throw new Error('fake-imap: sequence STORE used');
    return this.#store(range, flags, '+');
  }

  async messageFlagsRemove(range: string, flags: string[], options: { uid: true }): Promise<boolean> {
    if (!options.uid) throw new Error('fake-imap: sequence STORE used');
    return this.#store(range, flags, '-');
  }

  #transfer(range: string, destination: string, remove: boolean): object | false {
    const source = this.#selected();
    const target = this.server.mailboxes.get(destination);
    if (!target) return false;
    const moving = parseRange(range, source, true);
    let next = Math.max(0, ...target.messages.map((m) => m.uid)) + 1;
    for (const m of moving) target.messages.push({ ...m, uid: next++, flags: new Set(m.flags) });
    if (remove) source.messages = source.messages.filter((m) => !moving.includes(m));
    return { path: source.path, destination };
  }

  async messageMove(range: string, destination: string, options: { uid: true }): Promise<object | false> {
    if (!options.uid) throw new Error('fake-imap: sequence MOVE used');
    this.#cmd(`UID MOVE ${range} ${destination}`);
    if (!this.server.capabilities.has('MOVE')) throw new Error('fake-imap: MOVE used without the MOVE capability');
    if (this.server.failMove) return false;
    return this.#transfer(range, destination, true);
  }

  async messageCopy(range: string, destination: string, options: { uid: true }): Promise<object | false> {
    if (!options.uid) throw new Error('fake-imap: sequence COPY used');
    this.#cmd(`UID COPY ${range} ${destination}`);
    if (this.server.failCopy) return false;
    return this.#transfer(range, destination, false);
  }

  async messageDelete(range: string, options: { uid: true }): Promise<boolean> {
    // imapflow: STORE +FLAGS (\Deleted), then UID EXPUNGE with UIDPLUS, plain EXPUNGE without.
    this.#store(range, ['\\Deleted'], '+');
    const box = this.#selected();
    if (options.uid && this.server.capabilities.has('UIDPLUS')) {
      this.#cmd(`UID EXPUNGE ${range}`);
      const doomed = new Set(parseRange(range, box, true).filter((m) => m.flags.has('\\Deleted')));
      box.messages = box.messages.filter((m) => !doomed.has(m));
    } else {
      this.#cmd('EXPUNGE');
      box.messages = box.messages.filter((m) => !m.flags.has('\\Deleted'));
    }
    return true;
  }
}
