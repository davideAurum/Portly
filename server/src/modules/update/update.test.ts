import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateRun, UpdateStatusResponse } from '@portly/shared';
import { createApp } from '../../app.ts';
import { readInstallInfo } from '../../lib/install-info.ts';
import { createMemoryLogger } from '../../lib/logger.ts';
import { UPDATER_TASK, createUpdaterTask, schtasksPath, type ExecFile } from '../../lib/updater-task.ts';
import { createTestContext, type TestContext, type TestContextOverrides } from '../../testing/test-context.ts';
import { connectTestDevice } from '../../testing/test-devices.ts';
import { TEST_PAGES_ENV, TEST_PAGES_ORIGIN, TEST_REMOTE_ENV, TEST_REMOTE_ORIGIN, pagesHeaders, remoteHeaders, remotePagesHeaders, testRequest } from '../../testing/test-request.ts';
import { CHECK_TTL_MS, FINISHED_RUN_SHOWN_MS, REFRESH_LIMIT_MS, REQUESTED_STALE_MS, RUN_STALE_MS, TASK_RECHECK_MS } from './index.ts';

const RELEASES = 'api.github.com/repos/example/portly/releases/latest';
const NEWER = '99.0.0';

interface Harness {
  ctx: TestContext;
  app: ReturnType<typeof createApp>['app'];
  start: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
}

let harness: Harness | null = null;

function setup(overrides: TestContextOverrides = {}, started = true): Harness {
  const start = vi.fn(async () => started);
  const ctx = createTestContext({
    install: { releaseRepo: 'example/portly' },
    supervised: true,
    updaterTask: { exists: async () => true, start },
    fetchRoutes: [{ match: RELEASES, respond: { json: { tag_name: `v${NEWER}`, body: 'Ignored', assets: [] } } }],
    ...overrides,
  });
  mkdirSync(ctx.config.dataDir, { recursive: true });
  const { app } = createApp(ctx, { webDist: null });
  harness = { ctx, app, start };
  return harness;
}

afterEach(() => {
  vi.useRealTimers();
  if (harness !== null) {
    rmSync(harness.ctx.config.dataDir, { recursive: true, force: true });
    harness.ctx.close();
    harness = null;
  }
});

async function status(h: Harness, url = '/api/update'): Promise<UpdateStatusResponse> {
  const res = await testRequest(h.app, 'GET', url);
  expect(res.status).toBe(200);
  return (await res.json()) as UpdateStatusResponse;
}

function post(h: Harness, version: string = NEWER): Promise<Response> {
  return testRequest(h.app, 'POST', '/api/update', { body: { version } });
}

function writeStatus(h: Harness, run: unknown): void {
  writeFileSync(h.ctx.config.paths.updateStatus, typeof run === 'string' ? run : JSON.stringify(run), 'utf8');
}

function run(patch: Partial<UpdateRun> = {}): UpdateRun {
  return {
    id: 'run-1',
    state: 'installing',
    from: '0.1.0',
    to: NEWER,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    code: null,
    extensionChanged: false,
    ...patch,
  };
}

const githubCalls = (h: Harness): number => h.ctx.fakeFetch?.calls.length ?? 0;

describe('GET /api/update', () => {
  it('offers a newer release, with a link the server built, and reads nothing else from GitHub', async () => {
    const h = setup();
    const body = await status(h);
    expect(body).toMatchObject({ availability: 'ready', latest: NEWER, updateAvailable: true, checkFailed: false, run: null });
    expect(body.notesUrl).toBe(`https://github.com/example/portly/releases/tag/v${NEWER}`);
    expect(JSON.stringify(body)).not.toContain('Ignored');
  });

  it('does not offer the version it already runs, or an older one', async () => {
    const h = setup({ fetchRoutes: [{ match: RELEASES, respond: { json: { tag_name: 'v0.0.1' } } }] });
    expect(await status(h)).toMatchObject({ latest: '0.0.1', updateAvailable: false });
  });

  it.each([
    ['a Git checkout', { install: { releaseRepo: null } }, 'checkout'],
    ['a server the supervisor did not start', { supervised: false }, 'unsupervised'],
    ['a missing task', { updaterTask: { exists: async () => false, start: async () => false } }, 'no-task'],
  ] as const)('%s is not offered, and GitHub is not asked', async (_name, overrides, availability) => {
    const h = setup({ ...overrides, fetchRoutes: [] });
    expect(await status(h)).toMatchObject({ availability, latest: null, updateAvailable: false });
    expect(githubCalls(h)).toBe(0);
  });

  it.each([
    ['an error status', { status: 403, json: { message: 'rate limit' } }],
    ['no tag', { json: { name: 'x' } }],
    ['a tag that is no version', { json: { tag_name: 'v1.0.0; rm -rf' } }],
    ['text instead of JSON', { text: '<html>' }],
    ['an oversized body', { json: { tag_name: 'v1.0.0', body: 'x'.repeat(6 * 1024 * 1024) } }],
    ['a redirect', { status: 302, headers: { location: 'https://example.com/' } }],
  ])('treats %s from GitHub as a failed check', async (_name, respond) => {
    const h = setup({ fetchRoutes: [{ match: RELEASES, respond }] });
    expect(await status(h)).toMatchObject({ availability: 'ready', latest: null, updateAvailable: false, checkFailed: true });
  });

  it('asks GitHub at most hourly, and at most once a minute when asked to check again', async () => {
    const h = setup();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await status(h);
    await status(h);
    await status(h, '/api/update?refresh=1');
    expect(githubCalls(h)).toBe(1);
    vi.setSystemTime(Date.now() + REFRESH_LIMIT_MS + 1);
    await status(h);
    expect(githubCalls(h)).toBe(1);
    await status(h, '/api/update?refresh=1');
    expect(githubCalls(h)).toBe(2);
    vi.setSystemTime(Date.now() + CHECK_TTL_MS + 1);
    await status(h);
    expect(githubCalls(h)).toBe(3);
  });

  it('reports a run, and leaves out an old finished one', async () => {
    const h = setup();
    const done = run({ state: 'done', finishedAt: new Date().toISOString() });
    writeStatus(h, done);
    expect((await status(h)).run).toEqual(done);
    writeStatus(h, { ...done, finishedAt: new Date(Date.now() - FINISHED_RUN_SHOWN_MS - 1000).toISOString() });
    expect((await status(h)).run).toBeNull();
  });

  it('reads a byte order mark, which Windows PowerShell can write', async () => {
    const h = setup();
    writeStatus(h, `\uFEFF${JSON.stringify(run())}`);
    expect((await status(h)).run?.id).toBe('run-1');
  });

  it.each([
    ['broken JSON', '{'],
    ['an unknown state', { ...run(), state: 'hacked' }],
    ['free text', { ...run(), message: 'C:\\Users\\you\\secret' }],
    ['an unknown code', { ...run(), code: 'C:\\Users\\you' }],
    ['a version that is no version', { ...run(), to: '<img>' }],
  ])('treats a status file with %s as no run', async (_name, file) => {
    const h = setup();
    writeStatus(h, file);
    expect((await status(h)).run).toBeNull();
  });

  it('reports a run that stopped moving as failed: 2 minutes for the task to start, 20 to finish', async () => {
    const h = setup();
    writeStatus(h, run({ state: 'requested', startedAt: new Date(Date.now() - REQUESTED_STALE_MS - 1000).toISOString() }));
    expect((await status(h)).run).toMatchObject({ state: 'failed', code: 'unknown' });
    writeStatus(h, run({ state: 'installing', startedAt: new Date(Date.now() - REQUESTED_STALE_MS - 1000).toISOString() }));
    expect((await status(h)).run).toMatchObject({ state: 'installing' });
    writeStatus(h, run({ state: 'installing', startedAt: new Date(Date.now() - RUN_STALE_MS - 1000).toISOString() }));
    expect((await status(h)).run).toMatchObject({ state: 'failed', code: 'unknown' });
  });

  it('stops reporting a run that died, a day after it stopped moving', async () => {
    const h = setup();
    const startedAt = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();
    writeStatus(h, run({ state: 'installing', startedAt: startedAt(RUN_STALE_MS + FINISHED_RUN_SHOWN_MS - 60_000) }));
    expect((await status(h)).run).toMatchObject({ state: 'failed', code: 'unknown' });
    writeStatus(h, run({ state: 'installing', startedAt: startedAt(RUN_STALE_MS + FINISHED_RUN_SHOWN_MS + 60_000) }));
    expect((await status(h)).run).toBeNull();
  });

  it('dates a run that died from when it stopped moving, not from when it started', async () => {
    const h = setup();
    const startedAt = Date.now() - RUN_STALE_MS - 1000;
    writeStatus(h, run({ state: 'restarting', startedAt: new Date(startedAt).toISOString() }));
    expect((await status(h)).run?.finishedAt).toBe(new Date(startedAt + RUN_STALE_MS).toISOString());
  });

  it('reports a run that went quiet as done when this server is already the target', async () => {
    const h = setup();
    const stale = new Date(Date.now() - RUN_STALE_MS - 1000).toISOString();
    writeStatus(h, run({ state: 'restarting', startedAt: stale, to: h.ctx.config.version }));
    expect((await status(h)).run).toMatchObject({ state: 'done', code: null });
    writeStatus(h, run({ state: 'restarting', startedAt: stale, to: '0.0.1' }));
    expect((await status(h)).run).toMatchObject({ state: 'done', code: null });
  });

  it('asks Windows about a missing task at most once a minute, and shares one look', async () => {
    const exists = vi.fn(async () => false);
    const h = setup({ updaterTask: { exists, start: async () => false } });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await Promise.all([status(h), status(h), status(h)]);
    await status(h);
    expect(exists).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + TASK_RECHECK_MS + 1);
    await status(h);
    expect(exists).toHaveBeenCalledTimes(2);
  });

  it('stops asking once the task is found', async () => {
    const exists = vi.fn(async () => true);
    const h = setup({ updaterTask: { exists, start: async () => true } });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await status(h);
    vi.setSystemTime(Date.now() + TASK_RECHECK_MS + 1);
    await status(h);
    expect(exists).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/update', () => {
  it('writes the run, then starts the task', async () => {
    const h = setup();
    const res = await post(h);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { run: UpdateRun };
    expect(body.run).toMatchObject({ state: 'requested', to: NEWER, code: null });
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(h.ctx.config.paths.updateStatus, 'utf8'))).toEqual(body.run);
  });

  it('checks GitHub again, past the cache: a version that is no longer the newest is refused', async () => {
    const h = setup({
      fetchRoutes: [
        { match: RELEASES, times: 1, respond: { json: { tag_name: 'v98.0.0' } } },
        { match: RELEASES, respond: { json: { tag_name: `v${NEWER}` } } },
      ],
    });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await status(h);
    vi.setSystemTime(Date.now() + REFRESH_LIMIT_MS + 1);
    const stale = await post(h, '98.0.0');
    expect(stale.status).toBe(409);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('asks GitHub at most once a minute, however often it is posted to', async () => {
    const h = setup();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    for (let i = 0; i < 5; i++) expect((await post(h, '98.0.0')).status).toBe(409);
    expect(githubCalls(h)).toBe(1);
    vi.setSystemTime(Date.now() + REFRESH_LIMIT_MS + 1);
    expect((await post(h, '98.0.0')).status).toBe(409);
    expect(githubCalls(h)).toBe(2);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses anything but a newer release, without starting the task', async () => {
    const h = setup({ fetchRoutes: [{ match: RELEASES, respond: { json: { tag_name: 'v0.0.1' } } }] });
    expect((await post(h, '0.0.1')).status).toBe(409);
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each([['a path', 'C:\\evil'], ['a URL', 'https://example.com/x.zip'], ['an option', '-Force']])('refuses %s as the version', async (_name, version) => {
    const h = setup();
    expect((await post(h, version)).status).toBe(422);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses extra fields: a request cannot pass anything to the task', async () => {
    const h = setup();
    const res = await testRequest(h.app, 'POST', '/api/update', { body: { version: NEWER, force: true } });
    expect(res.status).toBe(422);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('answers 502 when GitHub cannot be reached, and starts nothing', async () => {
    const h = setup({ fetchRoutes: [{ match: RELEASES, respond: { status: 500 } }] });
    expect((await post(h)).status).toBe(502);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses where the button cannot work', async () => {
    const h = setup({ supervised: false, fetchRoutes: [] });
    expect((await post(h)).status).toBe(409);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('a run already going answers with that run; a second start never happens', async () => {
    const h = setup();
    const first = (await (await post(h)).json()) as { run: UpdateRun };
    const second = await post(h);
    expect(second.status).toBe(202);
    expect(((await second.json()) as { run: UpdateRun }).run.id).toBe(first.run.id);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('two clicks at once start one run', async () => {
    const h = setup();
    const [a, b] = await Promise.all([post(h), post(h)]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('records a task Windows refused as a failed run', async () => {
    const h = setup({}, false);
    expect((await post(h)).status).toBe(409);
    expect((await status(h)).run).toMatchObject({ state: 'failed', code: 'unknown' });
  });

  it('logs versions, never the status file path', async () => {
    const log = createMemoryLogger();
    const h = setup({ log });
    await post(h);
    expect(log.lines.some((line) => line.message === 'update started')).toBe(true);
    expect(JSON.stringify(log.lines)).not.toContain('update-status');
  });
});

describe('who may call it', () => {
  it("an approved PC may start an update from Portly's own page", async () => {
    const h = setup({ env: { ...TEST_REMOTE_ENV } });
    const { secret } = connectTestDevice(h.ctx);
    const res = await testRequest(h.app, 'POST', '/api/update', { body: { version: NEWER }, headers: remoteHeaders(secret, { Origin: TEST_REMOTE_ORIGIN }) });
    expect(res.status).toBe(202);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('the paired Pages site may read it, and may never start one', async () => {
    const h = setup({ env: { ...TEST_PAGES_ENV } });
    const { token } = h.ctx.pairing.create({ label: 'Chrome on Windows', origin: TEST_PAGES_ORIGIN });
    const read = await testRequest(h.app, 'GET', '/api/update', { headers: pagesHeaders(token) });
    expect(read.status).toBe(200);
    const refused = await testRequest(h.app, 'POST', '/api/update', { body: { version: NEWER }, headers: pagesHeaders(token) });
    expect(refused.status).toBe(403);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('the Pages site on another PC may read it, and may never start one, device secret or not', async () => {
    const h = setup({ env: { ...TEST_PAGES_ENV, ...TEST_REMOTE_ENV } });
    const { secret } = connectTestDevice(h.ctx);
    const read = await testRequest(h.app, 'GET', '/api/update', { headers: remotePagesHeaders(secret) });
    expect(read.status).toBe(200);
    const refused = await testRequest(h.app, 'POST', '/api/update', { body: { version: NEWER }, headers: remotePagesHeaders(secret) });
    expect(refused.status).toBe(403);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("this PC's own page may start one", async () => {
    const h = setup({ env: { ...TEST_PAGES_ENV } });
    expect((await post(h)).status).toBe(202);
  });

  it('without X-Portly the gate refuses it', async () => {
    const h = setup();
    const res = await testRequest(h.app, 'POST', '/api/update', { body: { version: NEWER }, headers: { 'X-Portly': null } });
    expect(res.status).toBe(403);
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe('readInstallInfo', () => {
  const root = path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', `portly-install-info-${process.pid}`);
  const app = path.join(root, 'app');

  beforeEach(() => mkdirSync(app, { recursive: true }));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (json: unknown): void => writeFileSync(path.join(app, 'release.json'), JSON.stringify(json));

  it('reads the release repository of a release install', () => {
    write({ name: 'portly', releaseRepo: 'example/portly' });
    expect(readInstallInfo(app)).toEqual({ releaseRepo: 'example/portly' });
  });

  it('counts everything else as a checkout', () => {
    expect(readInstallInfo(app)).toEqual({ releaseRepo: null });
    write({ name: 'other', releaseRepo: 'example/portly' });
    expect(readInstallInfo(app)).toEqual({ releaseRepo: null });
    write({ name: 'portly', releaseRepo: 'https://evil.example/x' });
    expect(readInstallInfo(app)).toEqual({ releaseRepo: null });
    write({ name: 'portly', releaseRepo: 'example/portly' });
    expect(readInstallInfo(root)).toEqual({ releaseRepo: null });
  });
});

describe('createUpdaterTask', () => {
  it('runs schtasks by its absolute path, with fixed arguments and no shell', async () => {
    const calls: { file: string; args: readonly string[]; shell: boolean }[] = [];
    const execFileImpl: ExecFile = (file, args, options, callback) => {
      calls.push({ file, args, shell: options.shell });
      callback(null);
    };
    const task = createUpdaterTask({ execFileImpl, program: 'C:\\Windows\\System32\\schtasks.exe' });
    expect(await task.start()).toBe(true);
    expect(await task.exists()).toBe(true);
    expect(calls).toEqual([
      { file: 'C:\\Windows\\System32\\schtasks.exe', args: ['/run', '/tn', UPDATER_TASK], shell: false },
      { file: 'C:\\Windows\\System32\\schtasks.exe', args: ['/query', '/tn', UPDATER_TASK], shell: false },
    ]);
  });

  it('answers false for a failure and for a program that cannot start', async () => {
    expect(await createUpdaterTask({ execFileImpl: (_f, _a, _o, callback) => callback(new Error('no task')) }).start()).toBe(false);
    expect(
      await createUpdaterTask({
        execFileImpl: () => {
          throw new Error('ENOENT');
        },
      }).exists(),
    ).toBe(false);
  });

  it('ignores a SystemRoot that is not a drive path', () => {
    expect(schtasksPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\schtasks.exe');
    expect(schtasksPath({ SystemRoot: '\\\\evil\\share' })).toBe('C:\\Windows\\System32\\schtasks.exe');
  });
});
