/**
 * In-memory state of the static backend with write-through persistence. State is a set of named
 * JSON "slices" (`settings`, `profiles`, `bookmarks`, …) owned by the handler modules, which read
 * them with {@link StaticState.get} (initializing on first use), mutate the returned object, and
 * then {@link StaticState.commit} the slice. Commits are written to storage and announced to
 * other tabs of the same deployment over a BroadcastChannel, which reload the slice and
 * invalidate their query cache (see `subscribeStaticChanges` in backend.ts).
 *
 * A commit is all-or-nothing: every named slice (plus any extra documents and blob writes) goes to
 * storage in ONE transaction, and when that fails the named slices are put back in memory as they
 * were last persisted, so memory never runs ahead of storage (the handler then answers 500).
 */
import type { StaticStorage, StoredBlob } from './storage/types.ts';

/** Namespaced like the database (storage/idb.ts): two deployments on one origin never cross-talk. */
export const STATIC_CHANNEL_NAME = `portly-static:${import.meta.env.BASE_URL}`;
const SLICE_PREFIX = 'slice:';

interface SlicesChangedMessage {
  type: 'slices-changed';
  keys: string[];
  sender: string;
}

export type ExternalChangeListener = (keys: readonly string[]) => void;

/** Minimal BroadcastChannel surface (so tests can inject a fake). */
export interface ChangeChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

/** Writes that {@link StaticState.commitWith} stores in the same transaction as the slices. */
export interface CommitExtras {
  /** Non-slice JSON documents by storage key (`undefined` deletes); never loaded at startup. */
  json?: ReadonlyMap<string, unknown>;
  deleteBlobs?: readonly string[];
  putBlobs?: readonly StoredBlob[];
  /** Who commits, for the commit hook: `'sync'` when launch pad sync applies a merge. */
  origin?: string;
}

/**
 * Runs at the start of every commit with the slice names and the origin. It may change slices in
 * memory and returns more slice names to write in the same transaction, and optionally a callback
 * for after the commit succeeded.
 */
export type CommitHook = (names: readonly string[], origin: string | undefined) => { extra: readonly string[]; committed?: () => void };

function openChannel(): ChangeChannel | null {
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    return new BroadcastChannel(STATIC_CHANNEL_NAME);
  } catch {
    return null;
  }
}

export class StaticState {
  readonly storage: StaticStorage;
  private readonly slices = new Map<string, unknown>();
  /** Each slice as last read from / written to storage (JSON text), for rolling back a failed commit. */
  private readonly committed = new Map<string, string>();
  private readonly channel: ChangeChannel | null;
  private readonly instanceId: string;
  private readonly listeners = new Set<ExternalChangeListener>();
  /** Reloads triggered by other tabs, in arrival order (never rejects). */
  private pending: Promise<void> = Promise.resolve();
  private commitHook: CommitHook | null = null;

  constructor(storage: StaticStorage, options: { channel?: ChangeChannel | null; instanceId?: string } = {}) {
    this.storage = storage;
    this.instanceId = options.instanceId ?? Math.random().toString(36).slice(2);
    this.channel = options.channel === undefined ? openChannel() : options.channel;
    this.channel?.addEventListener('message', (event) => {
      const message = event.data as Partial<SlicesChangedMessage> | null;
      if (!message || message.type !== 'slices-changed' || message.sender === this.instanceId || !Array.isArray(message.keys)) return;
      const keys = message.keys.filter((k): k is string => typeof k === 'string');
      this.pending = this.pending
        .then(() => this.reload(keys))
        .then(
          () => this.notify(keys),
          (err: unknown) => console.warn('[Portly] Could not reload data another tab changed', err),
        );
    });
  }

  /** Loads every persisted slice into memory (called once at startup). Non-slice keys are skipped. */
  async loadAll(): Promise<void> {
    const keys = await this.storage.listJsonKeys();
    for (const key of keys) {
      if (!key.startsWith(SLICE_PREFIX)) continue;
      this.remember(key.slice(SLICE_PREFIX.length), await this.storage.getJson(key));
    }
  }

  /** Resolves once every reload requested by another tab so far has been applied. */
  settled(): Promise<void> {
    return this.pending;
  }

  /** Whether a slice exists in storage/memory (used for first-run seeding). */
  has(name: string): boolean {
    return this.slices.has(name) && this.slices.get(name) !== undefined;
  }

  /**
   * Returns the slice, initializing it with `init()` when absent. The returned object is the live
   * in-memory value: mutate it, then `commit(name)`.
   */
  get<T>(name: string, init: () => T): T {
    const existing = this.slices.get(name);
    if (existing !== undefined) return existing as T;
    const value = init();
    this.slices.set(name, value);
    return value;
  }

  /** Replaces the in-memory slice (persist with `commit`). */
  set<T>(name: string, value: T): T {
    this.slices.set(name, value);
    return value;
  }

  /**
   * Writes the named slices to storage in one transaction and tells other tabs. On failure the
   * named slices are restored to their last persisted values and the error is rethrown.
   */
  commit(...names: string[]): Promise<void> {
    return this.commitWith(names);
  }

  /** {@link commit} plus other documents and blob writes, all in the same transaction. */
  async commitWith(requested: readonly string[], extras: CommitExtras = {}): Promise<void> {
    const texts = new Map<string, string | undefined>();
    const hooked = this.runCommitHook(requested, extras.origin);
    const names = hooked.names;
    try {
      // Serialized before the first await: a reload from another tab while the write is in
      // flight must not change what this commit writes.
      for (const name of names) {
        const value = this.slices.get(name);
        texts.set(name, value === undefined ? undefined : JSON.stringify(value));
      }
      const json = new Map<string, unknown>(extras.json ?? []);
      for (const [name, text] of texts) json.set(SLICE_PREFIX + name, text === undefined ? undefined : JSON.parse(text));
      await this.storage.applyBatch({ json, deleteBlobs: extras.deleteBlobs, putBlobs: extras.putBlobs });
    } catch (err) {
      this.rollback(names);
      throw err;
    }
    for (const [name, text] of texts) {
      if (text === undefined) this.committed.delete(name);
      else this.committed.set(name, text);
    }
    this.announce([...texts.keys()]);
    try {
      hooked.committed?.();
    } catch (err) {
      console.error('[Portly] A commit listener failed', err);
    }
  }

  /**
   * Installs the hook every commit runs before anything is serialized (one per state; null
   * removes it). Launch pad sync uses it to mark changes waiting and stamp the settings it syncs
   * in the same transaction (sync/hook.ts).
   */
  setCommitHook(hook: CommitHook | null): void {
    this.commitHook = hook;
  }

  private runCommitHook(names: readonly string[], origin: string | undefined): { names: readonly string[]; committed?: () => void } {
    if (!this.commitHook) return { names };
    try {
      const result = this.commitHook(names, origin);
      const extra = result.extra.filter((name) => !names.includes(name));
      return { names: extra.length > 0 ? [...names, ...extra] : names, committed: result.committed };
    } catch (err) {
      // The hook must never fail someone's change.
      console.error('[Portly] The commit hook failed', err);
      return { names };
    }
  }

  /** Deletes slices from storage and memory (one transaction). */
  async remove(...names: string[]): Promise<void> {
    await this.storage.applyBatch({ json: new Map(names.map((name) => [SLICE_PREFIX + name, undefined])) });
    for (const name of names) {
      this.slices.delete(name);
      this.committed.delete(name);
    }
    this.announce(names);
  }

  /** Re-reads the named slices (or all) from storage, replacing the in-memory values. */
  async reload(names?: readonly string[]): Promise<void> {
    const keys = names ?? [...this.slices.keys()];
    for (const name of keys) this.remember(name, await this.storage.getJson(SLICE_PREFIX + name));
  }

  /** Called with the slice names another tab changed (after they have been reloaded here). */
  onExternalChange(listener: ExternalChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Blob helpers (images) — stored outside the JSON slices. */
  getBlob(id: string): Promise<StoredBlob | undefined> {
    return this.storage.getBlob(id);
  }
  putBlob(entry: StoredBlob): Promise<void> {
    return this.storage.putBlob(entry);
  }
  deleteBlob(id: string): Promise<void> {
    return this.storage.deleteBlob(id);
  }
  listBlobs(): Promise<StoredBlob[]> {
    return this.storage.listBlobs();
  }
  /** Blob ids without their bytes. */
  listBlobIds(): Promise<string[]> {
    return this.storage.listBlobIds();
  }

  /** Wipes everything (import-and-replace, tests). Slices must be re-seeded afterwards. */
  async clearAll(): Promise<void> {
    const names = [...this.slices.keys()];
    this.slices.clear();
    this.committed.clear();
    await this.storage.clear();
    this.announce(names);
  }

  /** Names of the slices currently in memory. */
  sliceNames(): string[] {
    return [...this.slices.keys()];
  }

  close(): void {
    this.channel?.close();
  }

  /** Sets memory (and the rollback copy) to a value read from storage; `undefined` drops the slice. */
  private remember(name: string, value: unknown): void {
    if (value === undefined) {
      this.slices.delete(name);
      this.committed.delete(name);
      return;
    }
    this.slices.set(name, value);
    this.committed.set(name, JSON.stringify(value));
  }

  /** Puts the slices back as they were last persisted (dropping ones that never were). */
  private rollback(names: Iterable<string>): void {
    for (const name of names) {
      const text = this.committed.get(name);
      if (text === undefined) this.slices.delete(name);
      else this.slices.set(name, JSON.parse(text));
    }
  }

  private notify(keys: readonly string[]): void {
    for (const listener of this.listeners) {
      try {
        listener(keys);
      } catch (err) {
        console.error('[Portly] A cross-tab change listener failed', err);
      }
    }
  }

  private announce(keys: string[]): void {
    if (keys.length === 0) return;
    try {
      this.channel?.postMessage({ type: 'slices-changed', keys, sender: this.instanceId } satisfies SlicesChangedMessage);
    } catch {
      // A closed channel or a serialization problem must never fail a commit.
    }
  }
}
