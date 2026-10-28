/**
 * Static backend: launch pad sync's state for the page (`GET /api/sync/launchpad`) and Sync now
 * (`POST /api/sync/launchpad/now`): which sync connection is used (none, one, or two set up), the
 * stored status as the page should read it, the first-sync answer passed through, and never the
 * repository name or a token.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchpadSyncInfo } from '../../api/launchpadSync.ts';
import { GITHUB_TOKEN, REPOSITORY } from '../providers/__fixtures__/github.ts';
import { storeGitHubSync } from '../providers/githubSync.ts';
import { SLICE, getAccounts, getLaunchpadSync, type StoredAccount } from '../slices.ts';
import type { LaunchpadSyncController } from '../sync/scheduler.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as bookmarks from './bookmarks.ts';
import * as launchpadSync from './launchpadSync.ts';

const T0 = 1_800_000_000_000;
let t: TestBackend;

afterEach(() => t?.close());

function microsoft(id: string, sync = true): StoredAccount {
  return {
    id,
    kind: 'microsoft',
    label: `${id}@outlook.example`,
    email: `${id}@outlook.example`,
    externalId: `subject-${id}`,
    color: null,
    capabilities: ['calendar', 'launchpadSync'],
    enabledCapabilities: sync ? ['calendar', 'launchpadSync'] : ['calendar'],
    grantedScopes: [],
    requestedScopes: [],
    status: 'ok',
    statusMessage: null,
    sort: 0,
    createdAt: T0,
    updatedAt: T0,
  };
}

async function setup(accounts: StoredAccount[] = []) {
  t = await createTestBackend([bookmarks, launchpadSync], { startAt: T0 });
  getAccounts(t.ctx).push(...accounts);
  await t.ctx.state.commit(SLICE.accounts);
  return t;
}

const info = async () => (await t.json<LaunchpadSyncInfo>('GET', '/api/sync/launchpad')).body;

describe('launch pad sync: the page state', () => {
  it('is off without a sync connection, and not synced yet with one', async () => {
    await setup([microsoft('a', false)]);
    expect(await info()).toEqual({
      connection: null,
      connections: 0,
      status: 'off',
      problem: null,
      running: false,
      waiting: false,
      syncedAt: null,
      receivedAt: null,
      sentAt: null,
      retryAt: null,
    });
    getAccounts(t.ctx)[0]!.enabledCapabilities = ['calendar', 'launchpadSync'];
    await t.ctx.state.commit(SLICE.accounts);
    expect(await info()).toMatchObject({ connection: { kind: 'microsoft', accountId: 'a', label: 'a@outlook.example' }, connections: 1, status: 'off' });
  });

  it('reports the last round, the times as ISO and a backoff still ahead', async () => {
    await setup([microsoft('a')]);
    const state = getLaunchpadSync(t.ctx);
    Object.assign(state, { sourceId: 'microsoft:a', status: 'error', problem: 'network_error', syncedAt: T0 - 60_000, sentAt: T0 - 60_000, retryAt: T0 + 900_000, waiting: true });
    await t.ctx.state.commit(SLICE.launchpadSync);
    expect(await info()).toMatchObject({
      status: 'error',
      problem: 'network_error',
      waiting: true,
      syncedAt: new Date(T0 - 60_000).toISOString(),
      sentAt: new Date(T0 - 60_000).toISOString(),
      receivedAt: null,
      retryAt: new Date(T0 + 900_000).toISOString(),
    });
    t.tick(1_000_000);
    expect((await info()).retryAt).toBeNull();

    // Another connection now: nothing a round with it said yet.
    getAccounts(t.ctx)[0]!.enabledCapabilities = ['calendar'];
    getAccounts(t.ctx).push(microsoft('b'));
    await t.ctx.state.commit(SLICE.accounts);
    expect(await info()).toMatchObject({ connection: { kind: 'microsoft', accountId: 'b' }, status: 'off', problem: null, syncedAt: null, sentAt: null });
  });

  it('names GitHub without its repository, and says when two connections are set up', async () => {
    await setup();
    await storeGitHubSync(t.ctx, GITHUB_TOKEN, REPOSITORY);
    const github = await t.call('GET', '/api/sync/launchpad');
    const text = await github.text();
    expect(JSON.parse(text)).toMatchObject({ connection: { kind: 'github' }, connections: 1 });
    expect(text).not.toContain(REPOSITORY.name);
    expect(text).not.toContain(GITHUB_TOKEN);

    getAccounts(t.ctx).push(microsoft('a'));
    await t.ctx.state.commit(SLICE.accounts);
    // The stored status may be the last round's: two connections read as set up twice.
    getLaunchpadSync(t.ctx).status = 'up_to_date';
    expect(await info()).toMatchObject({ connection: null, connections: 2, status: 'several_sources' });
  });

  it('syncs now with the first-sync answer, and refuses without sync running on the page', async () => {
    await setup([microsoft('a')]);
    const refused = await t.json<{ error: { code: string } }>('POST', '/api/sync/launchpad/now', {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('not_configured');

    const syncNow = vi.fn(async () => {
      Object.assign(getLaunchpadSync(t.ctx), { sourceId: 'microsoft:a', status: 'up_to_date', syncedAt: T0 });
      return null;
    });
    t.ctx.launchpadSync = { syncNow, running: () => false } as unknown as LaunchpadSyncController;
    const res = await t.json<LaunchpadSyncInfo>('POST', '/api/sync/launchpad/now', { choice: 'use_synced' });
    expect(res.status).toBe(200);
    expect(syncNow).toHaveBeenCalledWith('use_synced');
    expect(res.body).toMatchObject({ status: 'up_to_date', syncedAt: new Date(T0).toISOString() });
    expect((await t.json('POST', '/api/sync/launchpad/now', { choice: 'combine' })).status).toBe(422);
  });

  it('says when a round is running on this page', async () => {
    await setup([microsoft('a')]);
    t.ctx.launchpadSync = { running: () => true } as unknown as LaunchpadSyncController;
    expect((await info()).running).toBe(true);
  });
});
