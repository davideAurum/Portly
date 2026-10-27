/**
 * One launch pad sync round (docs/design/launchpad-sync.md section 6.5), over any
 * {@link SyncStore}: nothing here knows OneDrive. The caller holds the sync lock (scheduler.ts).
 *
 * 1. Read the file. When its version is the one last merged and nothing local is waiting, stop:
 *    most checks end here, after one small request.
 * 2. Check it as hostile input (format.ts). A file from a newer Portly stops sync here; another
 *    refused file changes nothing and is never overwritten.
 * 3. Merge it with this browser's launch pad (`@portly/shared`), after forgetting what can no
 *    longer be trusted when the file has a new epoch or its horizon passed this browser's last
 *    sync; on a first sync where both sides have data, the user chooses (section 6.6). Then drop
 *    expired tombstones.
 * 4. Download the custom icons this browser lacks and check them; a network failure stops the
 *    round, an icon that fails its checks shows as automatic.
 * 5. Apply the result in one transaction (bookmarks, icons, settings, sync state, icon bytes, a
 *    safety backup first when needed), unless a local change came in meanwhile (then start again).
 * 6. When the result differs from the file: upload new icons (create-only), then write the file
 *    while it is still at the version read. Another browser writing in between is a conflict:
 *    start again from 1; after three rounds, give up as `busy`.
 *
 * Store failures ({@link SyncStoreError}) are thrown for the scheduler's backoff.
 */
import {
  forgetUnsynced,
  highestSyncStamp,
  liveLaunchpad,
  mergeLaunchpads,
  normalizeLaunchpad,
  pruneLaunchpad,
  serializeSyncFile,
  type SyncLaunchpad,
} from '@portly/shared';
import { recordClientEvent } from '../../diagnostics/clientLog.ts';
import type { StaticContext } from '../context.ts';
import { prepareBackup, type PreparedBackup } from '../handlers/transfer.ts';
import { newToken } from '../lib/ids.ts';
import { imageSize } from '../lib/imageSize.ts';
import { SLICE, getBackups, getIcons, getLaunchpadSync, type LaunchpadSyncSlice, type LaunchpadSyncStatus } from '../slices.ts';
import { blobOf } from '../storage/types.ts';
import { nextStamp, observeStamp } from './clock.ts';
import { checkSyncIcon, readSyncText } from './format.ts';
import { SYNC_ORIGIN } from './hook.ts';
import { buildLocalLaunchpad, planApply, type LocalLaunchpad, type ReceivedIcon } from './local.ts';
import type { SyncStore } from './store.ts';

/** Rounds tried before giving up as `busy` (another browser kept writing first). */
export const SYNC_ROUNDS = 3;
/** A merge that removes this many rows, or a quarter of them, takes a backup first (design 6.7). */
export const BACKUP_REMOVED_ROWS = 10;
/** Icon files the file stopped naming are deleted this long after. */
export const ICON_DELETE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** The user's answer when this browser and the file both have a launch pad on a first sync (design 6.6). */
export type FirstSyncChoice = 'use_synced' | 'replace_synced';

export interface SyncRoundOptions {
  /** The Microsoft connection (or other account) the store belongs to. */
  accountId: string;
  signal: AbortSignal;
  choice?: FirstSyncChoice;
}

export interface SyncRoundResult {
  status: LaunchpadSyncStatus;
  problem: string | null;
  /** This browser's launch pad changed. */
  received: boolean;
  /** The file was written. */
  sent: boolean;
}

/** A new file generation id. */
function newEpoch(): string {
  return newToken(12);
}

function hasRows(doc: SyncLaunchpad): boolean {
  const live = liveLaunchpad(doc);
  return live.groups.length > 0 || live.bookmarks.length > 0;
}

/** This browser's launch pad restamped as the newest version of every row, for a new epoch. */
function restamped(ctx: StaticContext, doc: SyncLaunchpad, epoch: string): SyncLaunchpad {
  const at = nextStamp(ctx);
  const live = liveLaunchpad(doc);
  return normalizeLaunchpad({
    ...doc,
    epoch,
    horizon: 0,
    groups: live.groups.map((g) => ({ ...g, updatedAt: at, placedAt: at })),
    bookmarks: live.bookmarks.map((b) => ({ ...b, updatedAt: at, placedAt: at })),
    deleted: [],
    pointers: { defaultGroupId: { ...doc.pointers.defaultGroupId, at }, ungroupedGroupId: { ...doc.pointers.ungroupedGroupId, at } },
  });
}

/** A new account starts over: its file is unknown here. */
function forAccount(state: LaunchpadSyncSlice, accountId: string): void {
  if (state.accountId === accountId) return;
  state.accountId = accountId;
  state.epoch = null;
  state.version = null;
  state.lastSynced = 0;
  state.icons = [];
  state.rehomed = {};
  state.refused = null;
  state.droppedIcons = [];
}

/** Records how the round ended (not a success) and commits the sync state. */
async function settle(ctx: StaticContext, status: LaunchpadSyncStatus, problem: string | null): Promise<SyncRoundResult> {
  const state = getLaunchpadSync(ctx);
  state.status = status;
  state.problem = problem;
  state.checkedAt = ctx.now();
  await ctx.state.commitWith([SLICE.launchpadSync], { origin: SYNC_ORIGIN });
  return { status, problem, received: false, sent: false };
}

/** The custom icons the merged launch pad uses that this browser lacks: downloaded and checked. */
async function receiveIcons(ctx: StaticContext, store: SyncStore, merged: SyncLaunchpad, local: LocalLaunchpad, signal: AbortSignal): Promise<ReceivedIcon[]> {
  const have = new Set(getIcons(ctx).map((icon) => icon.id));
  const entries = new Map(merged.icons.map((icon) => [icon.id, icon]));
  const wanted = new Set(liveLaunchpad(merged).bookmarks.flatMap((b) => (b.iconMode === 'custom' && b.iconId !== null ? [b.iconId] : [])));
  const received: ReceivedIcon[] = [];
  for (const id of wanted) {
    const entry = entries.get(id);
    if (have.has(id) || local.iconBytes.has(id) || !entry) continue;
    const blob = await store.readIcon(id, signal);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const check = await checkSyncIcon(bytes, entry);
    if (!check.ok) {
      recordClientEvent('warn', 'provider', 'a synced icon failed its checks', { provider: store.kind, code: check.problem });
      continue;
    }
    received.push({ id, type: check.contentType, bytes, width: entry.width ?? imageSize(bytes, check.contentType) });
  }
  return received;
}

/** Icons the file stopped naming are remembered, and deleted from the store 30 days later (best effort). */
async function retireIcons(ctx: StaticContext, store: SyncStore, before: SyncLaunchpad | null, after: SyncLaunchpad, signal: AbortSignal): Promise<void> {
  const state = getLaunchpadSync(ctx);
  const now = ctx.now();
  const named = new Set(after.icons.map((icon) => icon.id));
  const pending = new Map(state.droppedIcons.filter((d) => !named.has(d.id)).map((d) => [d.id, d.at]));
  for (const icon of before?.icons ?? []) if (!named.has(icon.id) && !pending.has(icon.id)) pending.set(icon.id, now);
  const due = [...pending].filter(([, at]) => now - at >= ICON_DELETE_AFTER_MS).map(([id]) => id);
  for (const id of due) {
    try {
      await store.deleteIcon(id, signal);
      pending.delete(id);
    } catch {
      break; // Kept for the next sync.
    }
  }
  state.droppedIcons = [...pending].map(([id, at]) => ({ id, at }));
}

/** Runs one sync round (see the module docs). Throws {@link SyncStoreError} for store failures. */
export async function runSyncRound(ctx: StaticContext, store: SyncStore, options: SyncRoundOptions): Promise<SyncRoundResult> {
  const { signal } = options;
  for (let round = 0; round < SYNC_ROUNDS; round++) {
    // Another tab may have changed the launch pad or synced since this page loaded.
    await ctx.state.reload([SLICE.bookmarks, SLICE.icons, SLICE.settings, SLICE.launchpadSync, SLICE.backups]);
    forAccount(getLaunchpadSync(ctx), options.accountId);

    const remote = await store.readMain(signal);
    let state = getLaunchpadSync(ctx);
    if (remote && state.epoch !== null && remote.version === state.version && !state.waiting) {
      state.status = 'up_to_date';
      state.problem = null;
      state.checkedAt = ctx.now();
      state.failures = 0;
      state.retryAt = 0;
      await ctx.state.commitWith([SLICE.launchpadSync], { origin: SYNC_ORIGIN });
      return { status: 'up_to_date', problem: null, received: false, sent: false };
    }

    let file: SyncLaunchpad | null = null;
    if (remote) {
      // The same refused file again: no need to parse it or report it twice.
      if (remote.version === state.refused && (state.status === 'refused' || state.status === 'stopped_newer')) return settle(ctx, state.status, state.problem);
      const read = readSyncText(remote.text, ctx.now());
      if (!read.ok) {
        recordClientEvent('warn', 'provider', 'the synced launch pad was refused', { provider: store.kind, code: read.problem });
        getLaunchpadSync(ctx).refused = remote.version;
        return settle(ctx, read.problem === 'newer_version' ? 'stopped_newer' : 'refused', read.problem);
      }
      file = read.doc;
    }

    const local = await buildLocalLaunchpad(ctx);
    state = getLaunchpadSync(ctx);
    const firstSync = state.epoch === null;
    let backup = false;
    let merged: SyncLaunchpad;
    if (!file) {
      // No file yet, or it disappeared after this browser synced: never "everything was deleted".
      merged = normalizeLaunchpad({ ...local.doc, epoch: state.epoch ?? newEpoch() });
    } else if (firstSync && hasRows(file) && hasRows(local.doc)) {
      if (options.choice === undefined) return settle(ctx, 'needs_choice', null);
      backup = options.choice === 'use_synced';
      merged = options.choice === 'use_synced' ? normalizeLaunchpad(file) : restamped(ctx, local.doc, newEpoch());
    } else if (firstSync) {
      merged = mergeLaunchpads({ ...local.doc, epoch: file.epoch }, file);
    } else if (file.epoch !== state.epoch) {
      // Another browser replaced the launch pad: keep only what changed here since the last sync.
      backup = true;
      merged = mergeLaunchpads(forgetUnsynced({ ...local.doc, epoch: file.epoch }, file, state.lastSynced), file);
    } else if (file.horizon > state.lastSynced) {
      merged = mergeLaunchpads(forgetUnsynced(local.doc, file, state.lastSynced), file);
    } else {
      merged = mergeLaunchpads(local.doc, file);
    }
    merged = pruneLaunchpad(merged, ctx.now());
    observeStamp(ctx, highestSyncStamp(merged));

    const received = await receiveIcons(ctx, store, merged, local, signal);

    // A safety backup first when the merge removes a lot or replaces this browser's launch pad.
    const draft = planApply(ctx, merged, local, received);
    const removesALot = draft.removed >= BACKUP_REMOVED_ROWS || (draft.before > 0 && draft.removed * 4 >= draft.before);
    let prepared: PreparedBackup | null = null;
    if (draft.changed && (backup || removesALot)) prepared = await prepareBackup(ctx, 'sync');

    // A local change since this round read the launch pad: start again, so it is merged too.
    const stored = await ctx.state.storage.getJson(`slice:${SLICE.launchpadSync}`);
    const storedChanges = typeof stored === 'object' && stored !== null ? (stored as { changes?: unknown }).changes : undefined;
    if (getLaunchpadSync(ctx).changes !== local.changes || (storedChanges !== undefined && storedChanges !== local.changes)) continue;

    // No await from here to the commit, which serializes the slices first.
    const plan = planApply(ctx, merged, local, received);
    plan.write();
    const names = [...plan.names];
    if (prepared) {
      getBackups(ctx).entries = prepared.entries;
      names.push(SLICE.backups);
    }
    await ctx.state.commitWith(names, { putBlobs: plan.putBlobs, json: prepared?.documents, origin: SYNC_ORIGIN });
    for (const icon of received) ctx.assets.registerBlob('icons', icon.id, blobOf({ bytes: icon.bytes, type: icon.type }));
    if (plan.changed) ctx.notify?.(names);

    // Write the file when the result differs from it: new icons first (create-only), then the file.
    const text = serializeSyncFile(plan.doc);
    let version = remote?.version ?? null;
    let sent = false;
    if (!file || text !== serializeSyncFile(file)) {
      const listed = new Set(file?.icons.map((icon) => icon.id) ?? []);
      for (const icon of plan.doc.icons) {
        if (listed.has(icon.id)) continue;
        const bytes = local.iconBytes.get(icon.id) ?? (await ctx.state.getBlob(icon.id))?.bytes;
        if (bytes) await store.writeIcon(icon.id, new Blob([new Uint8Array(bytes)]), signal);
      }
      const result = await store.writeMain(text, remote?.version ?? null, signal);
      if (!result.ok) continue;
      version = result.version;
      sent = true;
    }

    const now = ctx.now();
    state = getLaunchpadSync(ctx);
    state.accountId = options.accountId;
    state.epoch = plan.doc.epoch;
    state.version = version;
    state.lastSynced = highestSyncStamp(plan.doc);
    state.icons = plan.doc.icons;
    state.refused = null;
    if (state.changes === local.changes) state.waiting = false;
    state.syncedAt = now;
    state.checkedAt = now;
    if (plan.changed) state.receivedAt = now;
    if (sent) state.sentAt = now;
    state.status = 'up_to_date';
    state.problem = null;
    state.failures = 0;
    state.retryAt = 0;
    await retireIcons(ctx, store, file, plan.doc, signal);
    await ctx.state.commitWith([SLICE.launchpadSync], { origin: SYNC_ORIGIN });
    return { status: 'up_to_date', problem: null, received: plan.changed, sent };
  }
  return settle(ctx, 'busy', null);
}
