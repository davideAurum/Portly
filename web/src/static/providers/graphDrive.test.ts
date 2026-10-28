/**
 * The OneDrive store of launch pad sync (`graphDrive.ts`) against `createFakeFetch()`: the exact
 * Graph requests, downloads as simple credential-free requests to an allowed host only, the
 * conditional writes, create-only icons, the token's one refresh-and-retry, and how failures map
 * to `SyncStoreError` codes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as accounts from '../handlers/accounts.ts';
import { SLICE, getAccountTokens, getAccounts, getOAuthClients } from '../slices.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import { SyncStoreError } from '../sync/store.ts';
import { createFakeFetch, type FakeFetch } from './__fixtures__/fakeFetch.ts';
import { APPROOT, DOWNLOAD_ORIGIN, createFakeOneDrive, type FakeOneDrive } from './__fixtures__/fakeOneDrive.ts';
import { MICROSOFT_CLIENT_ID, tokenOk } from './__fixtures__/microsoft.ts';
import { MICROSOFT_TOKEN_ENDPOINT } from './microsoftAuth.ts';
import { createGraphDriveStore } from './graphDrive.ts';

const T0 = 1_700_000_000_000;
const ACCOUNT = 'acc-1';
const ICON = '7b1e3c3a-5f0e-4c11-9d7a-2f4f8f0b6a10';
const signal = () => new AbortController().signal;

let t: TestBackend;
let drive: FakeOneDrive;
let fake: FakeFetch;

beforeEach(async () => {
  drive = createFakeOneDrive();
  fake = createFakeFetch(drive.routes);
  vi.stubGlobal('fetch', fake.fetch);
  t = await createTestBackend([accounts], { startAt: T0 });
  getOAuthClients(t.ctx).microsoft = { clientId: MICROSOFT_CLIENT_ID, updatedAt: T0 };
  getAccounts(t.ctx).push({
    id: ACCOUNT,
    kind: 'microsoft',
    label: 'me@outlook.com',
    email: 'me@outlook.com',
    externalId: 'subject-1',
    color: null,
    capabilities: ['launchpadSync'],
    enabledCapabilities: ['launchpadSync'],
    grantedScopes: ['files.readwrite.appfolder'],
    requestedScopes: ['files.readwrite.appfolder'],
    status: 'ok',
    statusMessage: null,
    sort: 0,
    createdAt: T0,
    updatedAt: T0,
  });
  getAccountTokens(t.ctx)[ACCOUNT] = { refreshToken: 'RT', accessToken: 'AT', accessRefreshAt: T0 + 3_600_000, sessionExpiresAt: T0 + 86_400_000, silentAttemptAt: null };
  await t.ctx.state.commit(SLICE.oauthClients, SLICE.accounts, SLICE.accountTokens);
});

afterEach(() => {
  vi.unstubAllGlobals();
  t.close();
});

const store = () => createGraphDriveStore(t.ctx, ACCOUNT);

describe('reading the main file', () => {
  it('answers null when there is no file yet', async () => {
    expect(await store().readMain(signal())).toBeNull();
    expect(fake.calls.map((c) => c.url)).toEqual([`${APPROOT}/launchpad.json?select=id,eTag,cTag,size,@microsoft.graph.downloadUrl`]);
    expect(fake.calls[0]!.headers.get('authorization')).toBe('Bearer AT');
  });

  it('downloads through the download URL with no token, credentials or referrer, and only once per version', async () => {
    drive.put('/launchpad.json', '{"hello":1}');
    const s = store();
    const read = await s.readMain(signal());
    expect(read).toEqual({ text: '{"hello":1}', version: drive.files.get('/launchpad.json')!.eTag });
    const download = fake.calls.find((c) => c.url.startsWith(DOWNLOAD_ORIGIN))!;
    expect(download.headers.has('authorization')).toBe(false);
    expect(download.init).toMatchObject({ method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    expect(await s.readMain(signal())).toEqual(read);
    expect(drive.count('download')).toBe(1);
  });

  it('refuses a download URL on a host it does not allow, without fetching it', async () => {
    drive.failNext = [{ json: { id: 'x', eTag: '"e,1"', size: 10, '@microsoft.graph.downloadUrl': 'https://evil.example/file' } }];
    await expect(store().readMain(signal())).rejects.toMatchObject({ code: 'unavailable' });
    drive.failNext = [{ json: { id: 'x', eTag: '"e,2"', size: 10, '@microsoft.graph.downloadUrl': 'http://my.microsoftpersonalcontent.com/file' } }];
    await expect(store().readMain(signal())).rejects.toMatchObject({ code: 'unavailable' });
    expect(fake.calls.some((c) => !c.url.startsWith('https://graph.microsoft.com/'))).toBe(false);
  });

  it('refuses a body larger than its cap while downloading', async () => {
    // The metadata claims a small file; the download sends more than 25 MB.
    const big = createFakeFetch([{ match: `${DOWNLOAD_ORIGIN}/download/big`, respond: { bytes: new Uint8Array(25 * 1024 * 1024 + 1) } }, ...drive.routes]);
    vi.stubGlobal('fetch', big.fetch);
    drive.failNext = [{ json: { id: 'x', eTag: '"e,1"', size: 1, '@microsoft.graph.downloadUrl': `${DOWNLOAD_ORIGIN}/download/big` } }];
    await expect(store().readMain(signal())).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('writing the main file', () => {
  it('writes create-only without a version and with If-Match with one; a stale version is a conflict', async () => {
    const s = store();
    const created = await s.writeMain('{"v":1}', null, signal());
    expect(created).toEqual({ ok: true, version: drive.files.get('/launchpad.json')!.eTag });
    const put = fake.calls.at(-1)!;
    expect(put).toMatchObject({ method: 'PUT', url: `${APPROOT}/launchpad.json:/content?@microsoft.graph.conflictBehavior=fail`, body: '{"v":1}' });
    expect(put.headers.get('content-type')).toBe('application/json');

    expect(await s.writeMain('{"v":2}', null, signal())).toEqual({ ok: false, reason: 'conflict' });
    const updated = await s.writeMain('{"v":2}', created.ok ? created.version : '', signal());
    expect(updated.ok).toBe(true);
    expect(fake.calls.at(-1)!.headers.get('if-match')).toBe(created.ok ? created.version : '');
    expect(fake.calls.at(-1)!.url).toBe(`${APPROOT}/launchpad.json:/content`);
    expect(await s.writeMain('{"v":3}', created.ok ? created.version : '', signal())).toEqual({ ok: false, reason: 'conflict' });
    expect(drive.text('/launchpad.json')).toBe('{"v":2}');
  });

  it('refuses to upload a file over 25 MB', async () => {
    await expect(store().writeMain('x'.repeat(25 * 1024 * 1024 + 1), null, signal())).rejects.toMatchObject({ code: 'too_large' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('icons', () => {
  it('writes create-only (an existing icon is fine), reads, and deletes (a missing one is fine)', async () => {
    const s = store();
    const bytes = new Uint8Array([1, 2, 3]);
    await s.writeIcon(ICON, new Blob([bytes]), signal());
    expect(fake.calls.at(-1)!.url).toBe(`${APPROOT}/launchpad-icons/${ICON}:/content?@microsoft.graph.conflictBehavior=fail`);
    await s.writeIcon(ICON, new Blob([bytes]), signal());
    expect(new Uint8Array(await (await s.readIcon(ICON, signal()))!.arrayBuffer())).toEqual(bytes);
    await s.deleteIcon(ICON, signal());
    expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE', url: `${APPROOT}/launchpad-icons/${ICON}` });
    await s.deleteIcon(ICON, signal());
    expect(await s.readIcon(ICON, signal())).toBeNull();
  });

  it('never puts anything but a UUIDv4 into a path', async () => {
    for (const id of ['../launchpad.json', 'abc', ICON.toUpperCase(), `${ICON}/x`]) {
      await expect(store().readIcon(id, signal())).rejects.toMatchObject({ code: 'unavailable' });
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe('failures', () => {
  it('refreshes the token once on 401, then needs a reconnect', async () => {
    drive.failNext = [{ status: 401, json: { error: { code: 'InvalidAuthenticationToken' } } }];
    fake.add({ match: MICROSOFT_TOKEN_ENDPOINT, method: 'POST', respond: tokenOk({ access_token: 'AT2', refresh_token: 'RT2' }) });
    expect(await store().readMain(signal())).toBeNull();
    expect(fake.calls.filter((c) => c.url.startsWith(APPROOT)).map((c) => c.headers.get('authorization'))).toEqual(['Bearer AT', 'Bearer AT2']);

    drive.failNext = [{ status: 401 }, { status: 401 }];
    await expect(store().readMain(signal())).rejects.toMatchObject({ code: 'reauth_required' });
    expect(getAccounts(t.ctx)[0]!.status).toBe('reauth');
    // While the account needs reconnecting, nothing is sent.
    const sent = fake.calls.length;
    await expect(store().readMain(signal())).rejects.toMatchObject({ code: 'reauth_required' });
    expect(fake.calls).toHaveLength(sent);
  });

  it('maps rate limits, server errors and network failures', async () => {
    drive.failNext = [{ status: 503, headers: { 'retry-after': '30' } }];
    await expect(store().readMain(signal())).rejects.toEqual(new SyncStoreError('rate_limited', 'OneDrive is rate limiting requests', 30_000));
    drive.failNext = [{ status: 503 }];
    await expect(store().readMain(signal())).rejects.toMatchObject({ code: 'unavailable' });
    drive.failNext = [{ status: 507, json: { error: { code: 'quotaLimitReached' } } }];
    await expect(store().writeMain('{}', null, signal())).rejects.toMatchObject({ code: 'unavailable' });
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(store().readMain(signal())).rejects.toMatchObject({ code: 'network_error' });
  });

  it('rethrows the caller abort as it is', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(store().readMain(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
